import { AUTH_LIMITS, AuthError } from "../../shared/auth";

// Construct only from a verified HttpOnly session, never from request JSON.
export interface ContentWriteAccess {
  readonly tokenHash: string;
  readonly authVersion: number;
}

export function sessionGuard(access: ContentWriteAccess, now = Date.now()) {
  if (
    !access ||
    !/^[0-9a-f]{64}$/.test(access.tokenHash) ||
    !Number.isSafeInteger(access.authVersion) ||
    access.authVersion < 1 ||
    !Number.isSafeInteger(now)
  )
    throw new AuthError(401, "Authentication required.");
  return {
    sql: `EXISTS(SELECT 1 FROM admin_sessions s JOIN administrators a
      ON a.id=s.admin_id AND a.auth_version=s.auth_version
      WHERE a.id=1 AND s.token_hash=? AND s.auth_version=?
      AND s.expires_at>? AND s.last_seen_at>?)`,
    values: [
      access.tokenHash,
      access.authVersion,
      now,
      now - AUTH_LIMITS.idleMs,
    ],
  };
}
