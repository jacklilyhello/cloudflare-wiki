export const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Shared by the Actions-only driver and real workerd/D1 isolation tests. No raw
// password or recovery token is passed to SQL or made available to a Worker API.
export function recoveryStatement(
  input: {
    passwordHash: string;
    requestHash: string;
    expectedVersion: number;
    expiresAt: number;
  },
  now = Date.now(),
) {
  if (
    !/^scrypt\$16384\$8\$5\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(
      input.passwordHash,
    ) ||
    !/^[a-f0-9]{64}$/.test(input.requestHash) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    input.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= now ||
    input.expiresAt > now + RECOVERY_WINDOW_MS
  )
    throw new Error("Invalid or expired recovery request.");
  return {
    sql: `UPDATE administrators SET password_hash=?,recovery_request_hash=?,auth_version=auth_version+1,updated_at=?
      WHERE id=1 AND auth_version=? AND ?>CAST(unixepoch('subsec')*1000 AS INTEGER)
      AND ?<=CAST(unixepoch('subsec')*1000 AS INTEGER)+86400000
      AND NOT EXISTS(SELECT 1 FROM administrator_recoveries WHERE request_hash=?)
      RETURNING id,auth_version`,
    params: [
      input.passwordHash,
      input.requestHash,
      now,
      input.expectedVersion,
      input.expiresAt,
      input.expiresAt,
      input.requestHash,
    ],
  };
}
