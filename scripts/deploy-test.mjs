import { spawnSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildDeploymentConfig, validateDeployment } from "./deploy-policy.mjs";
import { workersDevBaseUrl } from "./smoke-policy.mjs";

const env = process.env;
validateDeployment(env);

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

const path = "dist/cloudflare_wiki/wrangler.json";
const config = buildDeploymentConfig(
  JSON.parse(await readFile(path, "utf8")),
  env,
);
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
// The lockfile pins Wrangler. No deployment credential is passed on the command line.
const result = spawnSync(
  "node_modules/.bin/wrangler",
  ["deploy", "--config", path],
  {
    stdio: "inherit",
    env: { ...env, WRANGLER_SEND_METRICS: "false" },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

async function verifyDeploymentReadback() {
  const [deployedDomains, scriptSubdomain] = await Promise.all([
    cf(`${account}/workers/domains`),
    cf(
      `${account}/workers/scripts/${encodeURIComponent(env.CLOUDFLARE_WORKER_NAME)}/subdomain`,
    ),
  ]);
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

if (!env.GITHUB_OUTPUT) throw new Error("Missing GitHub Actions output file.");
await appendFile(
  env.GITHUB_OUTPUT,
  `workers_dev_url=${workersDevUrl}\nworkers_dev_subdomain=${workersSubdomain.subdomain}\n`,
  "utf8",
);
console.log(
  "Cloudflare API readback confirmed custom-domain and workers.dev bindings.",
);
