import { createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  recoveryStatement,
  RECOVERY_WINDOW_MS,
} from "../shared/admin-recovery.ts";
import { validateDatabase, D1_NAME } from "./d1-policy.mjs";
import { validateDeployment } from "./deploy-policy.mjs";
import { verifyRecoveryEnvironment } from "./recovery-protection.mjs";
import { ownedD1, cloudflareClient } from "./owned-d1.mjs";

export function validateRecoveryContext(env) {
  validateDeployment(env);
  if (
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !==
      "jacklilyhello/cloudflare-wiki/.github/workflows/administrator-recovery.yml@refs/heads/main" ||
    env.RECOVERY_ENVIRONMENT !== "administrator-recovery" ||
    !["status", "apply"].includes(env.RECOVERY_OPERATION)
  )
    throw new Error("Recovery requires the protected manual main workflow.");
}
export function parseRecoveryBundle(raw, now = Date.now()) {
  let value;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096)
      throw new Error();
    value = JSON.parse(raw);
  } catch {
    throw new Error("ADMIN_RECOVERY_BUNDLE is missing or invalid.");
  }
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "expectedVersion,expiresAt,password,token" ||
    typeof value.password !== "string" ||
    [...value.password].length < 12 ||
    [...value.password].length > 128 ||
    Buffer.byteLength(value.password) > 512 ||
    /[\uD800-\uDFFF]/u.test(value.password) ||
    typeof value.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    Buffer.from(value.token, "base64url").toString("base64url") !==
      value.token ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 1 ||
    value.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt ||
    Date.parse(value.expiresAt) <= now ||
    Date.parse(value.expiresAt) > now + RECOVERY_WINDOW_MS
  )
    throw new Error("Recovery bundle fields or expiry are invalid.");
  return value;
}
export async function prepareRecovery(raw, now = Date.now()) {
  const value = parseRecoveryBundle(raw, now);
  const salt = randomBytes(16);
  const hash = await promisify(scrypt)(value.password, salt, 32, {
    N: 16384,
    r: 8,
    p: 5,
    maxmem: 32 * 1024 * 1024,
  });
  return {
    passwordHash: `scrypt$16384$8$5$${salt.toString("base64url")}$${hash.toString("base64url")}`,
    requestHash: createHash("sha256").update(value.token).digest("hex"),
    expectedVersion: value.expectedVersion,
    expiresAt: Date.parse(value.expiresAt),
  };
}

export async function recoverAdministrator(
  { env, databaseId, prepared },
  { fetch: fetchRequest = fetch, now = Date.now } = {},
) {
  validateRecoveryContext(env);
  validateDatabase({ name: D1_NAME, uuid: databaseId });
  const api = cloudflareClient(env, fetchRequest);
  if (env.RECOVERY_OPERATION === "status") {
    const rows = await api.query(
      databaseId,
      "SELECT id,auth_version FROM administrators WHERE id=1",
    );
    if (
      rows.length !== 1 ||
      rows[0].id !== 1 ||
      !Number.isSafeInteger(rows[0].auth_version)
    )
      throw new Error(
        "The original sole administrator is required; setup will not reopen.",
      );
    return { status: "ready", credentialVersion: rows[0].auth_version };
  }
  const statement = recoveryStatement(prepared, now());
  const consumed = await api.query(
    databaseId,
    "SELECT credential_version FROM administrator_recoveries WHERE request_hash=?",
    [prepared.requestHash],
  );
  if (consumed.length === 1) return { status: "already-used" };
  if (consumed.length !== 0) throw new Error("Invalid recovery ledger.");
  const rows = await api.query(databaseId, statement.sql, statement.params);
  if (
    rows.length !== 1 ||
    rows[0].id !== 1 ||
    rows[0].auth_version !== prepared.expectedVersion + 1
  )
    throw new Error(
      "Recovery not applied: stale version, expired request, or concurrent recovery. Inspect status; do not retry automatically.",
    );
  const verified = await api.query(
    databaseId,
    `SELECT a.id,a.auth_version FROM administrators a JOIN administrator_recoveries r ON r.administrator_id=a.id
    WHERE a.id=1 AND a.auth_version=? AND a.recovery_request_hash=? AND r.request_hash=? AND r.credential_version=a.auth_version
    AND NOT EXISTS(SELECT 1 FROM admin_sessions)
    AND EXISTS(SELECT 1 FROM audit_records WHERE category='administrator' AND action='administrator.credentials' AND subject_id='1' AND subject_version=a.auth_version)`,
    [prepared.expectedVersion + 1, prepared.requestHash, prepared.requestHash],
  );
  if (verified.length !== 1)
    throw new Error(
      "Recovery outcome requires inspection; readback was not confirmed. No retry.",
    );
  return { status: "recovered", credentialVersion: rows[0].auth_version };
}

async function main() {
  const env = { ...process.env };
  validateRecoveryContext(env);
  await verifyRecoveryEnvironment(env.GH_TOKEN);
  const raw = env.ADMIN_RECOVERY_BUNDLE;
  delete env.ADMIN_RECOVERY_BUNDLE;
  delete process.env.ADMIN_RECOVERY_BUNDLE;
  const prepared =
    env.RECOVERY_OPERATION === "apply" ? await prepareRecovery(raw) : undefined;
  const { databaseId } = await ownedD1(env);
  const result = await recoverAdministrator({ env, databaseId, prepared });
  console.log(
    `Administrator recovery: ${result.status}${result.credentialVersion ? `; credential version ${result.credentialVersion}` : ""}.`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      "Administrator recovery stopped. Check configuration, expiry and current version; a failed write can have an unknown outcome. No automatic retry or setup reopening.",
    );
    process.exitCode = 1;
  });
}
