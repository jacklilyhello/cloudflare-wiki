import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectD1 } from "./d1-provision.mjs";
import { validateDeployment } from "./deploy-policy.mjs";
import { verifyWorkerOwnership } from "./r2-policy.mjs";

// Existing retained resource, read-only ownership/ledger inspection. No provisioning.
export async function ownedD1(env, fetchRequest = fetch) {
  validateDeployment(env);
  const api = cloudflareClient(env, fetchRequest);
  const settings = await api.get(
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/cloudflare-wiki/settings`,
  );
  verifyWorkerOwnership(settings);
  const configPath = resolve("wrangler.jsonc");
  const migrationsDirectory = resolve("migrations");
  const migrationNames = (await readdir(migrationsDirectory)).filter((name) =>
    name.endsWith(".sql"),
  );
  const inspected = await inspectD1(
    {
      env,
      config: JSON.parse(await readFile(configPath, "utf8")),
      configPath,
      migrationsDirectory,
      migrationNames,
      workerSettings: settings,
    },
    { fetch: fetchRequest },
  );
  if (
    inspected.state !== "owned" ||
    inspected.appliedCount !== inspected.expectedNames.length
  )
    throw new Error(
      "Owned D1 with the complete current migration ledger is required.",
    );
  return { databaseId: inspected.databaseId, api };
}

export function cloudflareClient(env, fetchRequest = fetch) {
  async function request(path, body) {
    let response;
    try {
      response = await fetchRequest(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        },
      );
      const payload = await response.json();
      if (!response.ok || payload.success !== true) throw new Error();
      return payload.result;
    } catch {
      // Upstream errors can include SQL parameters. Never print them, and never
      // automatically retry a request whose mutation result is uncertain.
      throw new Error(
        "Cloudflare request failed; outcome may be unknown. No automatic retry.",
      );
    }
  }
  return {
    get: (path) => request(path),
    async query(databaseId, sql, params = []) {
      const result = await request(
        `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
        { sql, params },
      );
      if (
        !Array.isArray(result) ||
        result.length !== 1 ||
        result[0]?.success !== true ||
        !Array.isArray(result[0].results)
      )
        throw new Error(
          "Unverified D1 response; stop and inspect before retrying.",
        );
      return result[0].results;
    },
  };
}
