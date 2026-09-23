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

function client(env, fetchRequest) {
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

  async function query(databaseId, sql, params = []) {
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

  async function verifyMarker(databaseId) {
    const tables = await query(
      databaseId,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ["project_metadata"],
    );
    if (tables.length !== 1 || tables[0]?.name !== "project_metadata")
      throw new Error(
        "Existing D1 database has no ownership marker; inspect the creation run before requesting recovery. No marker was added.",
      );
    validateMarker(
      await query(
        databaseId,
        "SELECT app_id, environment, database_name FROM project_metadata LIMIT 2",
      ),
    );
  }

  return { accountPath, request, query, verifyMarker };
}

function ledgerSql(expectedNames) {
  return `SELECT name FROM d1_migrations ORDER BY name LIMIT ${expectedNames.length + 1}`;
}

// This preflight has only an injected transport: no resource creation, config
// writing or migration execution. Query POSTs contain only fixed SELECTs.
export async function inspectD1(
  {
    env,
    config,
    configPath,
    migrationsDirectory,
    migrationNames,
    workerSettings,
  },
  { fetch: fetchRequest },
) {
  validateDeployment(env);
  validateD1Config(config);
  const expectedNames = validateMigrationNames(migrationNames);
  if (!isAbsolute(migrationsDirectory) || !isAbsolute(configPath))
    throw new Error(
      "D1 deployment config and migrations paths must be absolute.",
    );
  const api = client(env, fetchRequest);

  // The API's name filter is a search, not an ownership or exact-match check.
  const candidates = [];
  let listedAll = false;
  for (let page = 1; page <= 100; page++) {
    const rows = await api.request(
      `${api.accountPath}?name=${D1_NAME}&page=${page}&per_page=100`,
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

  const database = candidates[0];
  if (!database) {
    // Never replace an existing Worker binding when its database was not found.
    verifyWorkerD1Binding(workerSettings, undefined, { allowAbsent: true });
    return { state: "absent", appliedCount: 0, expectedNames };
  }
  const databaseId = validateDatabase(database);
  verifyWorkerD1Binding(workerSettings, databaseId, { allowAbsent: true });
  await api.verifyMarker(databaseId);
  const appliedCount = validateMigrationLedger(
    await api.query(databaseId, ledgerSql(expectedNames)),
    expectedNames,
  );
  if (appliedCount === 0)
    throw new Error(
      "D1 ownership marker has no recorded bootstrap migration; refusing automatic recovery.",
    );
  return { state: "owned", databaseId, appliedCount, expectedNames };
}

// Reinspect immediately before provisioning; an earlier preflight is not
// authority to create or migrate after another resource has been checked.
// No mutation is retried, and successful process exit is not final readback.
export async function provisionD1(
  input,
  { fetch: fetchRequest, writeConfig, runWrangler },
) {
  const inspected = await inspectD1(input, { fetch: fetchRequest });
  const { env, config, configPath, migrationsDirectory, workerSettings } =
    input;
  const api = client(env, fetchRequest);
  let databaseId = inspected.databaseId;
  if (inspected.state === "absent") {
    databaseId = validateDatabase(
      await api.request(api.accountPath, "creation", { name: D1_NAME }),
    );
    verifyWorkerD1Binding(workerSettings, databaseId, { allowAbsent: true });
  }
  const { expectedNames, appliedCount } = inspected;
  const resolved = resolveD1Config(config, databaseId, migrationsDirectory);
  await writeConfig(resolved);
  if (appliedCount < expectedNames.length) {
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
  await api.verifyMarker(databaseId);
  validateMigrationLedger(
    await api.query(databaseId, ledgerSql(expectedNames)),
    expectedNames,
    true,
  );
  return { config: resolved, databaseId };
}
