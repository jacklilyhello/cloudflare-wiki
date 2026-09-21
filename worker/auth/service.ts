import {
  AUTH_LIMITS,
  AuthError,
  type AuthGrant,
  type AuthSession,
  type BootstrapStatus,
  type LoginInput,
  type PasswordChangeInput,
  type SetupInput,
  type UsernameChangeInput,
} from "../../shared/auth";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";

export { AuthError } from "../../shared/auth";

type AdminRow = {
  id: 1;
  username: string;
  password_hash: string;
  auth_version: number;
  created_at: number;
  updated_at: number;
};
type SessionRow = {
  token_hash: string;
  admin_id: 1;
  auth_version: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
};
type AuthorizedRow = SessionRow & { username: string; password_hash: string };
type SqlValue = string | number | null;

function username(value: unknown): string {
  if (typeof value !== "string") throw new AuthError(400, "Invalid username.");
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(trimmed))
    throw new AuthError(
      400,
      "Use 3–32 ASCII letters, digits, underscores or hyphens for the username.",
    );
  return trimmed.toLowerCase();
}
function password(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    [...value].length < AUTH_LIMITS.passwordMin ||
    [...value].length > AUTH_LIMITS.passwordMax ||
    new TextEncoder().encode(value).length > AUTH_LIMITS.passwordBytes ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    throw new AuthError(
      400,
      "Use a password of 12–128 characters, at most 512 UTF-8 bytes.",
    );
  return value;
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new AuthError(400, "Invalid administrator version.");
  return value as number;
}
function tokenValid(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export class AuthService {
  constructor(private readonly db: D1Database) {}

  private statement(sql: string, values: SqlValue[] = []) {
    return this.db.prepare(sql).bind(...values);
  }
  private async storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(503, "Authentication is unavailable.");
    }
  }
  private async sessionView(
    row: AuthorizedRow,
    rawToken: string,
  ): Promise<AuthSession> {
    return {
      user: { id: 1, username: row.username, version: row.auth_version },
      csrfToken: await sha256(`csrf:${rawToken}`),
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      idleExpiresAt: new Date(
        Math.min(row.expires_at, row.last_seen_at + AUTH_LIMITS.idleMs),
      ).toISOString(),
    };
  }
  private async readSession(rawToken: string): Promise<AuthorizedRow | null> {
    if (!tokenValid(rawToken)) return null;
    const now = Date.now();
    const tokenHash = await sha256(rawToken);
    return this.storage(() =>
      this.statement(
        `SELECT s.*,a.username,a.password_hash FROM admin_sessions s JOIN administrators a
       ON a.id=s.admin_id AND a.auth_version=s.auth_version
       WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>?`,
        [tokenHash, now, now - AUTH_LIMITS.idleMs],
      ).first<AuthorizedRow>(),
    );
  }
  private async rateLimit(
    ipHash: string,
    scope: "login" | "setup" | "credentials" = "login",
  ) {
    if (!/^[0-9a-f]{64}$/.test(ipHash))
      throw new AuthError(400, "Invalid request identity.");
    const now = Date.now();
    const since = now - AUTH_LIMITS.rateWindowMs;
    const key = `${scope}:ip:${ipHash}`;
    const budget = `NOT EXISTS(SELECT 1 FROM admin_login_limits
      WHERE bucket_key=? AND window_started_at>? AND attempts>=?)`;
    const budgetValues = [`${scope}:global`, since, AUTH_LIMITS.globalAttempts];
    const upsert = `ON CONFLICT(bucket_key) DO UPDATE SET
      attempts=CASE WHEN window_started_at<=? THEN 1 ELSE MIN(attempts+1,1000000) END,
      window_started_at=CASE WHEN window_started_at<=? THEN excluded.window_started_at ELSE window_started_at END
      RETURNING attempts`;
    const result = await this.storage(() =>
      this.db.batch<{ attempts: number }>([
        this.statement(
          `INSERT INTO admin_login_limits(bucket_key,window_started_at,attempts)
           SELECT ?,?,1 WHERE ${budget} ${upsert}`,
          [key, now, ...budgetValues, since, since],
        ),
        this.statement(
          `INSERT INTO admin_login_limits(bucket_key,window_started_at,attempts)
        SELECT ?,?,1 WHERE (SELECT attempts FROM admin_login_limits WHERE bucket_key=?)<=?
        AND ${budget} ${upsert}`,
          [
            `${scope}:global`,
            now,
            key,
            AUTH_LIMITS.perIpAttempts,
            ...budgetValues,
            since,
            since,
          ],
        ),
        this.statement(
          `DELETE FROM admin_login_limits WHERE bucket_key IN (
            SELECT bucket_key FROM admin_login_limits WHERE window_started_at<? ORDER BY window_started_at LIMIT 100)`,
          [now - 2 * AUTH_LIMITS.rateWindowMs],
        ),
      ]),
    );
    if (
      (result[0]?.results[0]?.attempts ?? Infinity) >
        AUTH_LIMITS.perIpAttempts ||
      (result[1]?.results[0]?.attempts ?? Infinity) > AUTH_LIMITS.globalAttempts
    )
      throw new AuthError(
        429,
        "Too many authentication attempts. Try again later.",
      );
  }
  async bootstrapStatus(): Promise<BootstrapStatus> {
    const row = await this.storage(() =>
      this.statement(
        `SELECT EXISTS(SELECT 1 FROM administrators) AS initialized,
       EXISTS(SELECT 1 FROM admin_bootstrap WHERE id=1 AND consumed_at IS NULL AND expires_at>?) AS available`,
        [Date.now()],
      ).first<{ initialized: number; available: number }>(),
    );
    return {
      initialized: Boolean(row?.initialized),
      setupAvailable: !row?.initialized && Boolean(row?.available),
    };
  }
  async setup(input: SetupInput, ipHash: string): Promise<AuthGrant> {
    await this.rateLimit(ipHash, "setup");
    const name = username(input?.username);
    const secret = password(input?.password);
    if (
      typeof input?.token !== "string" ||
      !/^[A-Za-z0-9_-]{43,256}$/.test(input.token)
    )
      throw new AuthError(403, "Setup is unavailable or the token is invalid.");
    const setupHash = await sha256(input.token);
    const eligible = `SELECT 1 FROM admin_bootstrap WHERE id=1 AND token_hash=? AND consumed_at IS NULL AND expires_at>?`;
    if (
      !(await this.storage(() =>
        this.statement(
          `${eligible} AND NOT EXISTS(SELECT 1 FROM administrators)`,
          [setupHash, Date.now()],
        ).first(),
      ))
    )
      throw new AuthError(403, "Setup is unavailable or the token is invalid.");
    const encoded = await hashPassword(secret);
    const rawToken = randomToken();
    const sessionHash = await sha256(rawToken);
    const now = Date.now();
    const expires = now + AUTH_LIMITS.absoluteMs;
    const owner =
      "SELECT 1 FROM administrators WHERE id=1 AND auth_version=1 AND password_hash=?";
    const results = await this.storage(() =>
      this.db.batch([
        this.statement(
          `INSERT INTO administrators(id,username,password_hash,auth_version,created_at,updated_at)
        SELECT 1,?,?,1,?,? WHERE EXISTS(${eligible}) AND NOT EXISTS(SELECT 1 FROM administrators)`,
          [name, encoded, now, now, setupHash, now],
        ),
        this.statement(
          `INSERT INTO admin_sessions(token_hash,admin_id,auth_version,created_at,expires_at,last_seen_at)
        SELECT ?,1,1,?,?,? WHERE EXISTS(${eligible}) AND EXISTS(${owner})`,
          [sessionHash, now, expires, now, setupHash, now, encoded],
        ),
        this.statement(
          `UPDATE admin_bootstrap SET consumed_at=? WHERE id=1 AND token_hash=? AND consumed_at IS NULL
        AND expires_at>? AND EXISTS(${owner}) RETURNING id`,
          [now, setupHash, now, encoded],
        ),
      ]),
    );
    if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1)
      throw new AuthError(409, "Administrator setup has already changed.");
    return {
      token: rawToken,
      session: await this.sessionView(
        {
          token_hash: sessionHash,
          admin_id: 1,
          auth_version: 1,
          username: name,
          password_hash: encoded,
          created_at: now,
          expires_at: expires,
          last_seen_at: now,
        },
        rawToken,
      ),
    };
  }
  async login(input: LoginInput, ipHash: string): Promise<AuthGrant> {
    await this.rateLimit(ipHash);
    let name: string;
    let secret: string;
    try {
      name = username(input?.username);
      secret = password(input?.password);
    } catch {
      throw new AuthError(401, "Invalid username or password.");
    }
    const admin = await this.storage(() =>
      this.statement(
        "SELECT * FROM administrators WHERE id=1",
      ).first<AdminRow>(),
    );
    if (
      !admin ||
      !(await verifyPassword(secret, admin.password_hash)) ||
      name !== admin.username
    )
      throw new AuthError(401, "Invalid username or password.");
    const rawToken = randomToken();
    const sessionHash = await sha256(rawToken);
    const now = Date.now();
    const expires = now + AUTH_LIMITS.absoluteMs;
    const results = await this.storage(() =>
      this.db.batch([
        this.statement(
          `DELETE FROM admin_sessions WHERE token_hash IN (
        SELECT token_hash FROM admin_sessions WHERE expires_at<=? OR last_seen_at<=? ORDER BY expires_at LIMIT 100)`,
          [now, now - AUTH_LIMITS.idleMs],
        ),
        this.statement(
          `INSERT INTO admin_sessions(token_hash,admin_id,auth_version,created_at,expires_at,last_seen_at)
       SELECT ?,id,auth_version,?,?,? FROM administrators WHERE id=1 AND auth_version=? AND password_hash=? AND username=?`,
          [
            sessionHash,
            now,
            expires,
            now,
            admin.auth_version,
            admin.password_hash,
            name,
          ],
        ),
      ]),
    );
    if (results[1]?.meta.changes !== 1)
      throw new AuthError(401, "Invalid username or password.");
    return {
      token: rawToken,
      session: await this.sessionView(
        {
          token_hash: sessionHash,
          admin_id: 1,
          auth_version: admin.auth_version,
          username: name,
          password_hash: admin.password_hash,
          created_at: now,
          expires_at: expires,
          last_seen_at: now,
        },
        rawToken,
      ),
    };
  }
  async getSession(rawToken: string): Promise<AuthSession | null> {
    const row = await this.readSession(rawToken);
    if (!row) return null;
    const now = Date.now();
    if (row.last_seen_at <= now - AUTH_LIMITS.touchMs) {
      const updated = await this.storage(() =>
        this.statement(
          `UPDATE admin_sessions SET last_seen_at=MAX(last_seen_at,?) WHERE token_hash=? AND auth_version=? AND expires_at>?
         AND last_seen_at>? AND EXISTS(SELECT 1 FROM administrators WHERE id=1 AND auth_version=?) RETURNING *`,
          [
            now,
            row.token_hash,
            row.auth_version,
            now,
            now - AUTH_LIMITS.idleMs,
            row.auth_version,
          ],
        ).first<SessionRow>(),
      );
      if (!updated) return null;
      row.last_seen_at = updated.last_seen_at;
    }
    return this.sessionView(row, rawToken);
  }
  async logout(rawToken: string): Promise<void> {
    if (!tokenValid(rawToken)) return;
    const hash = await sha256(rawToken);
    await this.storage(() =>
      this.statement("DELETE FROM admin_sessions WHERE token_hash=?", [
        hash,
      ]).run(),
    );
  }
  private async authorizeChange(
    rawToken: string,
    expectedVersion: number,
    currentPassword: string,
  ) {
    version(expectedVersion);
    const row = await this.readSession(rawToken);
    if (!row) throw new AuthError(401, "Sign in to continue.");
    if (row.auth_version !== expectedVersion)
      throw new AuthError(
        409,
        "Administrator credentials changed. Sign in again.",
      );
    await this.rateLimit(row.token_hash, "credentials");
    let secret: string;
    try {
      secret = password(currentPassword);
    } catch {
      throw new AuthError(401, "The current password is incorrect.");
    }
    if (!(await verifyPassword(secret, row.password_hash)))
      throw new AuthError(401, "The current password is incorrect.");
    return row;
  }
  private async updateCredentials(
    row: AuthorizedRow,
    field: "username" | "password_hash",
    value: string,
  ) {
    const now = Date.now();
    const result = await this.storage(() =>
      this.statement(
        `UPDATE administrators SET ${field}=?,auth_version=auth_version+1,updated_at=?
       WHERE id=1 AND auth_version=? AND password_hash=? AND EXISTS(
         SELECT 1 FROM admin_sessions WHERE token_hash=? AND admin_id=1 AND auth_version=? AND expires_at>? AND last_seen_at>?) RETURNING id`,
        [
          value,
          now,
          row.auth_version,
          row.password_hash,
          row.token_hash,
          row.auth_version,
          now,
          now - AUTH_LIMITS.idleMs,
        ],
      ).first<{ id: number }>(),
    );
    if (!result)
      throw new AuthError(
        409,
        "Administrator credentials or session changed. Sign in again.",
      );
  }
  async changePassword(
    rawToken: string,
    input: PasswordChangeInput,
  ): Promise<void> {
    const next = password(input?.newPassword);
    const row = await this.authorizeChange(
      rawToken,
      input?.expectedVersion,
      input?.currentPassword,
    );
    await this.updateCredentials(
      row,
      "password_hash",
      await hashPassword(next),
    );
  }
  async updateUsername(
    rawToken: string,
    input: UsernameChangeInput,
  ): Promise<void> {
    const next = username(input?.username);
    const row = await this.authorizeChange(
      rawToken,
      input?.expectedVersion,
      input?.currentPassword,
    );
    await this.updateCredentials(row, "username", next);
  }
}
