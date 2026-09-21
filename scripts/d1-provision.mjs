import { isAbsolute } from "node:path";
import {
  D1_NAME,
  resolveD1Config,
  validateD1Config,
  validateDatabase,
  validateMarker,
  validateMigrationLedger,
  validateMigrationNames,
  verifyWorkerD1Binding,
} from "./d1-policy.mjs";
import { validateDeployment } from "./deploy-policy.mjs";

// Inject transport, config writing and process execution so tests never need a
// Cloudflare credential or contact the account. No mutation is retried here.
export async function provisionD1(
  {
    env,
    config,
    configPath,
    migrationsDirectory,
    migrationNames,
    workerSettings,
  },
  { fetch: fetchRequest, writeConfig, runWrangler },
) {
  validateDeployment(env);
  validateD1Config(config);
  const expectedNames = validateMigrationNames(migrationNames);
  if (!isAbsolute(migrationsDirectory) || !isAbsolute(configPath))
    throw new Error(
      "D1 deployment config and migrations paths must be absolute.",
    );
  const accountPath = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database`;

  async function request(path, operation, body) {
    let response;
    try {
      response = await fetchRequest(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new Error(
        `D1 ${operation} request failed; outcome may be unknown. No automatic retry or resource replacement was attempted.`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `D1 ${operation} returned an invalid response; stopping without retry.`,
      );
    }
    if (!response.ok || payload?.success !== true) {
      const codes = Array.isArray(payload?.errors)
        ? payload.errors
            .map((error) => error?.code)
            .filter((code) => Number.isInteger(code))
            .join(",")
        : "";
      throw new Error(
        `D1 ${operation} failed: HTTP ${response.status}; API codes: ${codes}. No permissions will be expanded automatically.`,
      );
    }
    return payload.result;
  }

  // The API's name filter is a search, not an ownership or exact-match check.
  const candidates = [];
  let listedAll = false;
  for (let page = 1; page <= 100; page++) {
    const rows = await request(
      `${accountPath}?name=${D1_NAME}&page=${page}&per_page=100`,
      "lookup",
    );
    if (!Array.isArray(rows))
      throw new Error("D1 lookup returned invalid database records.");
    candidates.push(...rows.filter((row) => row?.name === D1_NAME));
    if (rows.length < 100) {
      listedAll = true;
      break;
    }
  }
  if (!listedAll || candidates.length > 1)
    throw new Error(
      "D1 lookup is ambiguous or incomplete; refusing to provision.",
    );

  let database = candidates[0];
  const created = !database;
  if (created) {
    // Never replace an existing Worker binding when its database was not found.
    verifyWorkerD1Binding(workerSettings, undefined, { allowAbsent: true });
    database = await request(accountPath, "creation", { name: D1_NAME });
  }
  const databaseId = validateDatabase(database);
  verifyWorkerD1Binding(workerSettings, databaseId, { allowAbsent: true });
  const resolved = resolveD1Config(config, databaseId, migrationsDirectory);

  async function query(sql, params = []) {
    const results = await request(
      `${accountPath}/${databaseId}/query`,
      "verification",
      { sql, params },
    );
    if (
      !Array.isArray(results) ||
      results.length !== 1 ||
      results[0]?.success !== true ||
      !Array.isArray(results[0].results)
    )
      throw new Error(
        "D1 verification query did not return a successful result.",
      );
    return results[0].results;
  }

  async function verifyMarker() {
    const tables = await query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ["project_metadata"],
    );
    if (tables.length !== 1 || tables[0]?.name !== "project_metadata")
      throw new Error(
        "Existing D1 database has no ownership marker; inspect the creation run before requesting recovery. No marker was added.",
      );
    validateMarker(
      await query(
        "SELECT app_id, environment, database_name FROM project_metadata LIMIT 2",
      ),
    );
  }

  const ledgerSql = `SELECT name FROM d1_migrations ORDER BY name LIMIT ${expectedNames.length + 1}`;

  let applied = 0;
  if (!created) {
    await verifyMarker();
    applied = validateMigrationLedger(await query(ledgerSql), expectedNames);
    if (applied === 0)
      throw new Error(
        "D1 ownership marker has no recorded bootstrap migration; refusing automatic recovery.",
      );
  }
  await writeConfig(resolved);
  if (applied < expectedNames.length) {
    await runWrangler([
      "d1",
      "migrations",
      "apply",
      D1_NAME,
      "--remote",
      "--config",
      configPath,
      "--experimental-provision=false",
      "--experimental-auto-create=false",
    ]);
  }
  await verifyMarker();
  validateMigrationLedger(await query(ledgerSql), expectedNames, true);
  return { config: resolved, databaseId };
}
