import { AUTH_LIMITS } from "../shared/auth";
import type { ContentWriteAccess } from "../worker/auth/access";
import { sha256 } from "../worker/auth/crypto";
import { ContentService } from "../worker/content/service";

// Local D1 test data only. No bootstrap credential or production bypass exists.
export const fixtureSessionToken = "A".repeat(43);
export const fixtureAccess: ContentWriteAccess = {
  tokenHash: await sha256(fixtureSessionToken),
  authVersion: 1,
};

export async function seedContentAccess(
  db: D1Database,
): Promise<ContentWriteAccess> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT OR IGNORE INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(1,'fixture-owner','not-a-password-verifier',?,?)",
    )
    .bind(now, now)
    .run();
  const admin = await db
    .prepare("SELECT auth_version FROM administrators WHERE id=1")
    .first<{ auth_version: number }>();
  if (!admin) throw new Error("Missing test administrator.");
  const access: ContentWriteAccess = {
    tokenHash: fixtureAccess.tokenHash,
    authVersion: admin.auth_version,
  };
  await db
    .prepare(
      `INSERT INTO admin_sessions(token_hash,auth_version,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)
       ON CONFLICT(token_hash) DO UPDATE SET auth_version=excluded.auth_version,created_at=excluded.created_at,expires_at=excluded.expires_at,last_seen_at=excluded.last_seen_at`,
    )
    .bind(
      access.tokenHash,
      access.authVersion,
      now,
      now + AUTH_LIMITS.absoluteMs,
      now,
    )
    .run();
  return access;
}

export async function contentFixture(db: D1Database) {
  const access = await seedContentAccess(db);
  return { access, service: new ContentService(db, access) };
}
