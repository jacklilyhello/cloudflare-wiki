import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBuiltBranding } from "./build-branding.mjs";
import { verifyWorkerD1Binding } from "./d1-policy.mjs";
import {
  buildDeploymentConfig,
  PUBLIC_DOMAINS,
  PUBLIC_ORIGIN,
  validateDeployment,
} from "./deploy-policy.mjs";
import { validateDomainPreflight, validateDomains } from "./domain-policy.mjs";
import { productionStorage } from "./production-storage.mjs";
import { verifyWorkerR2Binding } from "./r2-policy.mjs";

const env = { ...process.env };
validateDeployment(env);
env.BRANDING_JSON = await readBuiltBranding();
delete env.ADMIN_SETUP_TOKEN;
delete process.env.ADMIN_SETUP_TOKEN;

async function cf(path, allowNotFound = false) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    redirect: "error",
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (allowNotFound && response.status === 404) return null;
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    // Never print upstream bodies, request headers, or credentials.
    throw new Error(
      `Cloudflare preflight failed: HTTP ${response.status}; API codes: ${(body.errors ?? []).map((error) => error.code).join(",")}. No permissions will be expanded automatically.`,
    );
  }
  return body.result;
}

const account = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const zone = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}`);
if (
  zone.name !== "emby.wiki" ||
  zone.account.id !== env.CLOUDFLARE_ACCOUNT_ID ||
  zone.status !== "active"
) {
  throw new Error(
    "Variables must identify the active emby.wiki zone in the selected account.",
  );
}
const domains = await cf(`${account}/workers/domains`);
const settings = await cf(
  `${account}/workers/scripts/${env.CLOUDFLARE_WORKER_NAME}/settings`,
  true,
);
const routes = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}/workers/routes`);
const records = Object.fromEntries(
  await Promise.all(
    PUBLIC_DOMAINS.map(async (hostname) => [
      hostname,
      await cf(
        `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(hostname)}&per_page=5000`,
      ),
    ]),
  ),
);
validateDomainPreflight({
  domains,
  routes,
  records,
  zoneId: env.CLOUDFLARE_ZONE_ID,
});

const path = resolve("dist/cloudflare_wiki/wrangler.json");
const config = buildDeploymentConfig(
  JSON.parse(await readFile(path, "utf8")),
  env,
);
function runWrangler(args) {
  // The lockfile pins Wrangler. No credential is passed on the command line.
  const result = spawnSync("node_modules/.bin/wrangler", args, {
    stdio: "inherit",
    env: { ...env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Wrangler failed with exit status ${result.status ?? "unavailable"}; no automatic retry was attempted.`,
    );
}
const migrationsDirectory = resolve("migrations");
const migrationNames = (
  await readdir(migrationsDirectory, { withFileTypes: true })
)
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name);
const { databaseId, config: resolved } = await productionStorage(
  {
    env,
    config,
    configPath: path,
    migrationsDirectory,
    migrationNames,
    workerSettings: settings,
  },
  {
    fetch,
  },
);
await writeFile(path, `${JSON.stringify(resolved, null, 2)}\n`);
console.log(
  "Existing D1/R2 ownership, bindings and complete migration ledger verified; storage unchanged.",
);
runWrangler([
  "deploy",
  "--config",
  path,
  "--experimental-provision=false",
  "--experimental-auto-create=false",
]);

async function verifyDeploymentReadback() {
  const [deployedDomains, scriptSubdomain, deployedSettings] =
    await Promise.all([
      cf(`${account}/workers/domains`),
      cf(
        `${account}/workers/scripts/${encodeURIComponent(env.CLOUDFLARE_WORKER_NAME)}/subdomain`,
      ),
      cf(`${account}/workers/scripts/${env.CLOUDFLARE_WORKER_NAME}/settings`),
    ]);
  verifyWorkerD1Binding(deployedSettings, databaseId);
  verifyWorkerR2Binding(deployedSettings);
  for (const [name, value] of Object.entries({
    APP_ID: "jacklilyhello/cloudflare-wiki",
    APP_ENV: "production",
    BUILD_SHA: env.GITHUB_SHA,
    BRANDING_JSON: env.BRANDING_JSON,
    PUBLIC_ORIGIN,
  })) {
    const matches =
      deployedSettings.bindings?.filter((binding) => binding.name === name) ??
      [];
    if (
      matches.length !== 1 ||
      matches[0].type !== "plain_text" ||
      matches[0].text !== value
    )
      throw new Error(
        "Deployment variables did not match the reviewed production build.",
      );
  }
  validateDomains(deployedDomains, env.CLOUDFLARE_ZONE_ID, true);
  if (scriptSubdomain.enabled !== false) {
    throw new Error(
      "Cloudflare API readback did not confirm workers.dev is disabled.",
    );
  }
  if (scriptSubdomain.previews_enabled !== false) {
    throw new Error(
      "Cloudflare API readback did not confirm Preview URLs are disabled for cloudflare-wiki.",
    );
  }
}

let readbackFailure;
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    await verifyDeploymentReadback();
    readbackFailure = undefined;
    break;
  } catch (error) {
    readbackFailure = error;
    console.log(
      `Cloudflare deployment readback attempt ${attempt}/12 failed: ${error.message}`,
    );
    if (attempt < 12) await delay(5_000);
  }
}
if (readbackFailure) throw readbackFailure;

console.log(
  "Cloudflare API readback confirmed all three production Custom Domains, exact deployment SHA, existing storage and disabled workers.dev/Preview URLs.",
);
