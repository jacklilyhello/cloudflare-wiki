import { TEST_DOMAIN, WORKER_NAME } from "./deploy-policy.mjs";

export const LOCAL_SMOKE_BASE_URL = "http://127.0.0.1:4173";

const workersDevSubdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function workersDevBaseUrl(accountSubdomain) {
  if (
    typeof accountSubdomain !== "string" ||
    !workersDevSubdomainPattern.test(accountSubdomain)
  ) {
    throw new Error("Invalid Cloudflare Workers account subdomain.");
  }
  return `https://${WORKER_NAME}.${accountSubdomain}.workers.dev`;
}

export function validateSmokeBaseUrl(base, accountSubdomain) {
  const workersDevBase = accountSubdomain
    ? workersDevBaseUrl(accountSubdomain)
    : undefined;
  const allowedBases = new Set([
    LOCAL_SMOKE_BASE_URL,
    `https://${TEST_DOMAIN}`,
    workersDevBase,
  ]);
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Smoke test base URL must be a valid URL.");
  }
  if (url.origin !== base || !allowedBases.has(base)) {
    throw new Error(
      "Smoke tests are restricted to localhost, cf.emby.wiki, or the exact Cloudflare-derived workers.dev URL.",
    );
  }
  return url;
}
