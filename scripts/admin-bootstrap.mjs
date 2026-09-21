import { createHash } from "node:crypto";
import { D1_NAME, validateDatabase } from "./d1-policy.mjs";
import { validateDeployment } from "./deploy-policy.mjs";

const setupWindowMs = 24 * 60 * 60 * 1000;

// Read the optional Actions secret once; only its digest reaches D1. The caller
// removes the original environment variable before starting any child process.
export function prepareAdminBootstrap(env) {
  validateDeployment(env);
  const token = env.ADMIN_SETUP_TOKEN;
  if (token === undefined || token === "") return null;
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43,256}$/.test(token) ||
    Buffer.from(token, "base64url").length < 32 ||
    Buffer.from(token, "base64url").toString("base64url") !== token
  )
    throw new Error(
      "ADMIN_SETUP_TOKEN must encode at least 32 random bytes as unpadded base64url (43–256 characters).",
    );
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Called only after provisionD1 has verified ownership and the migration ledger.
// A single guarded statement is atomic against administrator setup. Reusing the
// same token never extends or reopens its window, even after expiry.
export async function bootstrapAdmin(
  { env, databaseId, tokenHash },
  { fetch: fetchRequest, now = Date.now },
) {
  validateDeployment(env);
  validateDatabase({ name: D1_NAME, uuid: databaseId });
  if (tokenHash === null) return "not-configured";
  if (typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(tokenHash))
    throw new Error("Invalid administrator bootstrap digest.");
  const expiresAt = now() + setupWindowMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= setupWindowMs)
    throw new Error("Invalid administrator bootstrap time.");

  let response;
  try {
    response = await fetchRequest(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sql: `INSERT INTO admin_bootstrap(id,token_hash,expires_at,consumed_at)
            SELECT 1, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM administrators)
            ON CONFLICT(id) DO UPDATE SET
              token_hash=excluded.token_hash, expires_at=excluded.expires_at
            WHERE admin_bootstrap.consumed_at IS NULL
              AND admin_bootstrap.token_hash <> excluded.token_hash
              AND NOT EXISTS (SELECT 1 FROM administrators)
            RETURNING id`,
          params: [tokenHash, expiresAt],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error(
      "Administrator bootstrap request failed; outcome may be unknown. No automatic retry was attempted.",
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "Administrator bootstrap returned an invalid response; stopping without retry.",
    );
  }
  if (!response.ok || payload?.success !== true) {
    const codes = Array.isArray(payload?.errors)
      ? payload.errors
          .map((error) => error?.code)
          .filter(Number.isInteger)
          .join(",")
      : "";
    throw new Error(
      `Administrator bootstrap failed: HTTP ${response.status}; API codes: ${codes}. No automatic retry was attempted.`,
    );
  }
  const result = payload.result?.[0];
  if (
    !Array.isArray(payload.result) ||
    payload.result.length !== 1 ||
    result?.success !== true ||
    !Array.isArray(result.results) ||
    ![0, 1].includes(result.meta?.changes) ||
    result.results.length !== result.meta.changes ||
    (result.meta.changes === 1 && result.results[0]?.id !== 1)
  )
    throw new Error(
      "Administrator bootstrap did not return a verified result; stopping without retry.",
    );
  return result.meta.changes === 1 ? "configured" : "unchanged";
}
