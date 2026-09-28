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

// Compatibility fixtures exercise the SQL emitted by the previous Worker on
// pre-upgrade schemas. The new Worker intentionally requires its new migration.
export function legacyRevisionDatabase(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.replace(
              ", (SELECT path FROM revision_link_bases WHERE revision_id=page_revisions.id) AS link_base_path",
              "",
            ),
          );
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export async function legacyMoveDraft(
  db: D1Database,
  id: string,
  version: number,
  path: string,
) {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT INTO page_routes(language,path,translation_id,created_at) SELECT language,?,id,? FROM page_translations WHERE id=? AND write_version=?",
      )
      .bind(path, now, id, version),
    db
      .prepare(
        "INSERT INTO page_events(id,translation_id,event_type,version,revision_id,from_path,to_path,change_note,created_at) SELECT ?,id,'move',write_version+1,published_revision_id,slug,?,'',? FROM page_translations WHERE id=? AND write_version=?",
      )
      .bind(crypto.randomUUID(), path, now, id, version),
    db
      .prepare(
        "UPDATE page_translations SET slug=?,write_version=write_version+1,updated_at=? WHERE id=? AND write_version=?",
      )
      .bind(path, now, id, version),
  ]);
}
