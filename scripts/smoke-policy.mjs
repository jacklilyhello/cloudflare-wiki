import { PUBLIC_DOMAINS } from "./deploy-policy.mjs";

export const LOCAL_SMOKE_BASE_URL = "http://127.0.0.1:4173";

export function validateSmokeBaseUrl(base) {
  const allowedBases = new Set([
    LOCAL_SMOKE_BASE_URL,
    ...PUBLIC_DOMAINS.map((domain) => `https://${domain}`),
  ]);
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Smoke test base URL must be a valid URL.");
  }
  if (url.origin !== base || !allowedBases.has(base)) {
    throw new Error(
      "Smoke tests are restricted to localhost and the three fixed production Custom Domains.",
    );
  }
  return url;
}
