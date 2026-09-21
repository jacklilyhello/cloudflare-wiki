import { spawnSync } from "node:child_process";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bootstrapAdmin, prepareAdminBootstrap } from "./admin-bootstrap.mjs";
import { verifyWorkerD1Binding } from "./d1-policy.mjs";
import { provisionD1 } from "./d1-provision.mjs";
import { buildDeploymentConfig, validateDeployment } from "./deploy-policy.mjs";
import { workersDevBaseUrl } from "./smoke-policy.mjs";

const env = { ...process.env };
validateDeployment(env);
if (!env.GITHUB_OUTPUT) throw new Error("Missing GitHub Actions output file.");
const setupTokenHash = prepareAdminBootstrap(env);
delete env.ADMIN_SETUP_TOKEN;
delete process.env.ADMIN_SETUP_TOKEN;

async function cf(path, allowNotFound = false) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
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
const workersSubdomain = await cf(`${account}/workers/subdomain`);
const workersDevUrl = workersDevBaseUrl(workersSubdomain.subdomain);
for (const domain of domains) {
  if (
    domain.hostname === env.TEST_DOMAIN &&
    domain.service !== env.CLOUDFLARE_WORKER_NAME
  ) {
    throw new Error(
      "The test hostname belongs to another Worker; refusing to replace it.",
    );
  }
  if (
    domain.service === env.CLOUDFLARE_WORKER_NAME &&
    domain.hostname !== env.TEST_DOMAIN
  ) {
    throw new Error(
      "The selected Worker has another hostname; refusing to modify it.",
    );
  }
}
const settings = await cf(
  `${account}/workers/scripts/${env.CLOUDFLARE_WORKER_NAME}/settings`,
  true,
);
if (
  settings &&
  !settings.bindings?.some(
    (binding) =>
      binding.name === "APP_ID" &&
      binding.text === "jacklilyhello/cloudflare-wiki",
  )
) {
  throw new Error(
    "An existing Worker has no project ownership marker; refusing to overwrite it.",
  );
}
const routes = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}/workers/routes`);
if (routes.some((route) => route.script === env.CLOUDFLARE_WORKER_NAME)) {
  throw new Error(
    "The Worker already has a route; inspect it before deploying this custom-domain-only project.",
  );
}
const records = await cf(
  `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(env.TEST_DOMAIN)}`,
);
const ownedDomain = domains.some(
  (domain) =>
    domain.hostname === env.TEST_DOMAIN &&
    domain.service === env.CLOUDFLARE_WORKER_NAME,
);
if (records.length && !ownedDomain) {
  throw new Error(
    "The test hostname has existing DNS records; refusing to replace or delete them.",
  );
}

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
const { databaseId } = await provisionD1(
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
    writeConfig: (resolved) =>
      writeFile(path, `${JSON.stringify(resolved, null, 2)}\n`),
    runWrangler,
  },
);
const bootstrapStatus = await bootstrapAdmin(
  { env, databaseId, tokenHash: setupTokenHash },
  { fetch },
);
console.log(`Administrator bootstrap: ${bootstrapStatus}.`);
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
  if (
    !deployedDomains.some(
      (domain) =>
        domain.hostname === env.TEST_DOMAIN &&
        domain.service === env.CLOUDFLARE_WORKER_NAME,
    )
  ) {
    throw new Error(
      "Cloudflare API readback did not confirm cf.emby.wiki is bound to cloudflare-wiki.",
    );
  }
  if (scriptSubdomain.enabled !== true) {
    throw new Error(
      "Cloudflare API readback did not confirm workers.dev is enabled for cloudflare-wiki.",
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

await appendFile(
  env.GITHUB_OUTPUT,
  `workers_dev_url=${workersDevUrl}\nworkers_dev_subdomain=${workersSubdomain.subdomain}\n`,
  "utf8",
);
console.log(
  "Cloudflare API readback confirmed custom-domain and workers.dev bindings.",
);
