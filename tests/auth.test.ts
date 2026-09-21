import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "../shared/auth";
import {
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from "../worker/auth/crypto";
import { AuthService } from "../worker/auth/service";

const service = new AuthService(env.DB);
// Synthetic inputs are local fixtures, never a deployed administrator credential.
const fixturePassword = "local-test-fixture-only";
const nextPassword = "replacement-fixture-only";
const ip = (index = 1) => index.toString(16).padStart(64, "0");

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("DELETE FROM admin_bootstrap"),
    env.DB.prepare("DELETE FROM admin_login_limits"),
  ]);
});

async function provision(expires = Date.now() + 60_000) {
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO admin_bootstrap(id,token_hash,expires_at) VALUES(1,?,?)",
  )
    .bind(await sha256(token), expires)
    .run();
  return token;
}
async function setup() {
  return service.setup(
    { token: await provision(), username: "Owner", password: fixturePassword },
    ip(),
  );
}
async function count(table: "administrators" | "admin_sessions") {
  return (
    await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first<{
      count: number;
    }>()
  )?.count;
}
async function login(address = ip()) {
  return service.login(
    { username: "owner", password: fixturePassword },
    address,
  );
}

// Pause at a real database statement, after service validation and any KDF work.
// The statement still executes in workerd D1; only scheduling is controlled.
function beforeStatement(
  pattern: string,
  hook: (values: unknown[]) => Promise<void>,
) {
  function wrap(
    statement: D1PreparedStatement,
    values: unknown[] = [],
  ): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args), args);
        if (key === "first")
          return async (column?: string) => {
            await hook(values);
            return column === undefined ? target.first() : target.first(column);
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }
  return new AuthService(
    new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.startsWith(pattern) ? wrap(statement) : statement;
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }),
  );
}

describe("single administrator authentication in workerd", () => {
  it("keeps setup closed without a bootstrap and after expiry", async () => {
    expect(await service.bootstrapStatus()).toEqual({
      initialized: false,
      setupAvailable: false,
    });
    const token = await provision(Date.now() - 1);
    await expect(
      service.setup(
        { token, username: "owner", password: fixturePassword },
        ip(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("administrators")).toBe(0);
  });

  it("consumes setup once and persists only a password verifier and hashed session", async () => {
    const token = await provision();
    expect(await service.bootstrapStatus()).toEqual({
      initialized: false,
      setupAvailable: true,
    });
    const grant = await service.setup(
      { token, username: " Owner ", password: fixturePassword },
      ip(),
    );
    expect(grant.session.user).toEqual({
      id: 1,
      username: "owner",
      version: 1,
    });
    expect(grant.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.session.csrfToken).toBe(await sha256(`csrf:${grant.token}`));
    expect(grant.session.csrfToken).not.toBe(await sha256(grant.token));
    const row = await env.DB.prepare("SELECT * FROM administrators").first<{
      password_hash: string;
    }>();
    expect(row?.password_hash).toMatch(/^scrypt\$16384\$8\$5\$/);
    expect(JSON.stringify(row)).not.toContain(fixturePassword);
    const session = await env.DB.prepare(
      "SELECT * FROM admin_sessions",
    ).first();
    expect(session?.token_hash).toBe(await sha256(grant.token));
    expect(JSON.stringify(session)).not.toContain(grant.token);
    expect(await service.bootstrapStatus()).toEqual({
      initialized: true,
      setupAvailable: false,
    });
    await expect(
      service.setup(
        { token, username: "second", password: fixturePassword },
        ip(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await count("administrators")).toBe(1);
    expect(await count("admin_sessions")).toBe(1);
  });

  it("allows only one concurrent setup without an orphan session", async () => {
    const token = await provision();
    const results = await Promise.allSettled([
      service.setup(
        { token, username: "first", password: fixturePassword },
        ip(1),
      ),
      service.setup(
        { token, username: "second", password: fixturePassword },
        ip(2),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected");
    expect(
      loser?.status === "rejected" && [403, 409].includes(loser.reason.status),
    ).toBe(true);
    expect(await count("administrators")).toBe(1);
    expect(await count("admin_sessions")).toBe(1);
  });

  it("rolls back administrator creation if session insertion fails", async () => {
    const token = await provision();
    await env.DB.prepare(
      "CREATE TRIGGER test_session_failure BEFORE INSERT ON admin_sessions BEGIN SELECT RAISE(ABORT, 'test_failure'); END",
    ).run();
    try {
      await expect(
        service.setup(
          { token, username: "owner", password: fixturePassword },
          ip(),
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(await count("administrators")).toBe(0);
      expect(
        (
          await env.DB.prepare(
            "SELECT consumed_at FROM admin_bootstrap",
          ).first()
        )?.consumed_at,
      ).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER test_session_failure").run();
    }
  });

  it.each(["ab", "用户", "Kelvin", "has space", "x".repeat(33), "a/b"])(
    "rejects an invalid ASCII username %s",
    async (username) => {
      const token = await provision();
      await expect(
        service.setup({ token, username, password: fixturePassword }, ip()),
      ).rejects.toMatchObject({ status: 400 });
      expect(await count("administrators")).toBe(0);
    },
  );

  it.each(["short", "x".repeat(129), "😀".repeat(129), "valid-prefix-\ud800"])(
    "rejects invalid password input",
    async (password) => {
      await expect(
        service.setup(
          { token: await provision(), username: "owner", password },
          ip(),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await count("administrators")).toBe(0);
    },
  );

  it("uses fresh salts, accepts Unicode without truncation, and bounds concurrent KDFs", async () => {
    const value = "中文😀".repeat(5);
    const first = await hashPassword(value);
    const second = await hashPassword(value);
    expect(first).not.toBe(second);
    expect(await verifyPassword(value, first)).toBe(true);
    expect(await verifyPassword(`${value}x`, first)).toBe(false);
    const results = await Promise.allSettled([
      hashPassword(value),
      hashPassword(value),
      hashPassword(value),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 429 },
    });
    expect(await verifyPassword(value, second)).toBe(true);
  });

  it("does not accept tampered verifier parameters or malformed encodings", async () => {
    const valid = await hashPassword(fixturePassword);
    for (const invalid of [
      valid.replace("16384", "1048576"),
      `${valid}x`,
      "pbkdf2$1$bad",
      valid.replace(/\$[^$]+$/, "$short"),
    ])
      await expect(
        verifyPassword(fixturePassword, invalid),
      ).rejects.toMatchObject({ status: 503 });
  });

  it("returns the same login error for an unknown username and a wrong password", async () => {
    await setup();
    await expect(
      service.login({ username: "unknown", password: fixturePassword }, ip()),
    ).rejects.toMatchObject({
      status: 401,
      message: "Invalid username or password.",
    });
    await expect(
      service.login({ username: "owner", password: nextPassword }, ip()),
    ).rejects.toMatchObject({
      status: 401,
      message: "Invalid username or password.",
    });
    const grant = await login();
    expect((await service.getSession(grant.token))?.user.username).toBe(
      "owner",
    );
    expect(await service.getSession(grant.token.slice(1))).toBeNull();
    expect(await service.getSession(randomToken())).toBeNull();
    expect(await service.getSession(grant.session.csrfToken)).toBeNull();
  });

  it("atomically limits an IP to five attempts and lets its window expire", async () => {
    // Malformed passwords do not consume KDF CPU, but still consume the budget.
    const attempt = () =>
      service.login({ username: "owner", password: "short" }, ip());
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, attempt),
    );
    expect(
      results.filter((r) => r.status === "rejected" && r.reason.status === 401),
    ).toHaveLength(5);
    expect(
      results.filter((r) => r.status === "rejected" && r.reason.status === 429),
    ).toHaveLength(1);
    await env.DB.prepare("UPDATE admin_login_limits SET window_started_at=?")
      .bind(Date.now() - AUTH_LIMITS.rateWindowMs - 1)
      .run();
    await expect(attempt()).rejects.toMatchObject({ status: 401 });
  });

  it("limits distributed login attempts globally without username-specific buckets", async () => {
    for (let i = 1; i <= 30; i++)
      await expect(
        service.login({ username: `user${i}`, password: "short" }, ip(i)),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.login({ username: "different", password: "short" }, ip(31)),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      (
        await env.DB.prepare(
          "SELECT attempts FROM admin_login_limits WHERE bucket_key='login:global'",
        ).first()
      )?.attempts,
    ).toBe(30);
    const rejected = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        service.login({ username: "different", password: "short" }, ip(i + 40)),
      ),
    );
    expect(
      rejected.every((r) => r.status === "rejected" && r.reason.status === 429),
    ).toBe(true);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS count FROM admin_login_limits WHERE bucket_key LIKE 'login:%'",
        ).first()
      )?.count,
    ).toBe(31);
    await expect(
      service.login({ username: "owner", password: "short" }, "plaintext-ip"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not let a blocked IP consume the remaining global login budget", async () => {
    for (let i = 0; i < 8; i++)
      await service
        .login({ username: "owner", password: "short" }, ip())
        .catch(() => undefined);
    expect(
      (
        await env.DB.prepare(
          "SELECT attempts FROM admin_login_limits WHERE bucket_key='login:global'",
        ).first()
      )?.attempts,
    ).toBe(5);
  });

  it("enforces absolute and idle expiry, and throttles last-seen writes", async () => {
    const grant = await setup();
    const hash = await sha256(grant.token);
    const first = await env.DB.prepare(
      "SELECT last_seen_at FROM admin_sessions WHERE token_hash=?",
    )
      .bind(hash)
      .first();
    await service.getSession(grant.token);
    expect(
      (
        await env.DB.prepare(
          "SELECT last_seen_at FROM admin_sessions WHERE token_hash=?",
        )
          .bind(hash)
          .first()
      )?.last_seen_at,
    ).toBe(first?.last_seen_at);
    const past = Date.now() - AUTH_LIMITS.touchMs - 1000;
    await env.DB.prepare(
      "UPDATE admin_sessions SET created_at=?,last_seen_at=? WHERE token_hash=?",
    )
      .bind(past, past, hash)
      .run();
    const touched = await service.getSession(grant.token);
    expect(Date.parse(touched?.idleExpiresAt ?? "")).toBeGreaterThan(
      past + AUTH_LIMITS.idleMs,
    );
    const expired = Date.now() - AUTH_LIMITS.idleMs - 1000;
    await env.DB.prepare(
      "UPDATE admin_sessions SET created_at=?,last_seen_at=? WHERE token_hash=?",
    )
      .bind(expired, expired, hash)
      .run();
    expect(await service.getSession(grant.token)).toBeNull();
    await env.DB.prepare(
      "UPDATE admin_sessions SET expires_at=?,last_seen_at=? WHERE token_hash=?",
    )
      .bind(Date.now() - 1, Date.now(), hash)
      .run();
    expect(await service.getSession(grant.token)).toBeNull();
  });

  it("revokes logout immediately and keeps logout idempotent", async () => {
    const grant = await setup();
    await service.logout(grant.token);
    expect(await service.getSession(grant.token)).toBeNull();
    await service.logout(grant.token);
    expect(await count("admin_sessions")).toBe(0);
  });

  it("does not let a delayed session touch move last-seen backwards", async () => {
    const grant = await setup();
    const hash = await sha256(grant.token);
    const past = Date.now() - AUTH_LIMITS.touchMs - 1000;
    await env.DB.prepare(
      "UPDATE admin_sessions SET created_at=?,last_seen_at=? WHERE token_hash=?",
    )
      .bind(past, past, hash)
      .run();
    let laterTouch = 0;
    const delayed = beforeStatement(
      "UPDATE admin_sessions SET",
      async (values) => {
        laterTouch = Number(values[0]) + 10_000;
        await env.DB.prepare(
          "UPDATE admin_sessions SET last_seen_at=? WHERE token_hash=?",
        )
          .bind(laterTouch, hash)
          .run();
      },
    );
    const result = await delayed.getSession(grant.token);
    expect(
      (
        await env.DB.prepare(
          "SELECT last_seen_at FROM admin_sessions WHERE token_hash=?",
        )
          .bind(hash)
          .first()
      )?.last_seen_at,
    ).toBe(laterTouch);
    expect(Date.parse(result?.idleExpiresAt ?? "")).toBe(
      laterTouch + AUTH_LIMITS.idleMs,
    );
  });

  it("rejects a credential update when its session is revoked after hashing but before the atomic write", async () => {
    const grant = await setup();
    const delayed = beforeStatement("UPDATE administrators SET", () =>
      service.logout(grant.token),
    );
    await expect(
      delayed.changePassword(grant.token, {
        currentPassword: fixturePassword,
        newPassword: nextPassword,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await env.DB.prepare("SELECT auth_version FROM administrators").first())
        ?.auth_version,
    ).toBe(1);
    expect(await count("admin_sessions")).toBe(0);
    expect((await login()).session.user.version).toBe(1);
  });

  it("does not mint a session if the password changes after login verification", async () => {
    const grant = await setup();
    let batches = 0;
    const delayed = new AuthService(
      new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (++batches === 2)
                await service.changePassword(grant.token, {
                  currentPassword: fixturePassword,
                  newPassword: nextPassword,
                  expectedVersion: 1,
                });
              return target.batch(statements);
            };
          const member = Reflect.get(target, key, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      }),
    );
    await expect(
      delayed.login({ username: "owner", password: fixturePassword }, ip()),
    ).rejects.toMatchObject({ status: 401 });
    expect(await count("admin_sessions")).toBe(0);
    expect(
      (await service.login({ username: "owner", password: nextPassword }, ip()))
        .session.user.version,
    ).toBe(2);
  });

  it("requires the current password and version, then revokes every session on a password change", async () => {
    const grant = await setup();
    const other = await login();
    await expect(
      service.changePassword(grant.token, {
        currentPassword: nextPassword,
        newPassword: nextPassword,
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.changePassword(grant.token, {
        currentPassword: fixturePassword,
        newPassword: nextPassword,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await service.changePassword(grant.token, {
      currentPassword: fixturePassword,
      newPassword: nextPassword,
      expectedVersion: 1,
    });
    expect(await service.getSession(grant.token)).toBeNull();
    expect(await service.getSession(other.token)).toBeNull();
    expect(await count("admin_sessions")).toBe(0);
    await expect(login()).rejects.toMatchObject({ status: 401 });
    const fresh = await service.login(
      { username: "owner", password: nextPassword },
      ip(),
    );
    expect(fresh.session.user.version).toBe(2);
  });

  it("has one winning concurrent password update and no surviving old session", async () => {
    const grant = await setup();
    const results = await Promise.allSettled([
      service.changePassword(grant.token, {
        currentPassword: fixturePassword,
        newPassword: nextPassword,
        expectedVersion: 1,
      }),
      service.changePassword(grant.token, {
        currentPassword: fixturePassword,
        newPassword: "other-replacement-fixture",
        expectedVersion: 1,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    expect(await count("admin_sessions")).toBe(0);
    expect(
      (await env.DB.prepare("SELECT auth_version FROM administrators").first())
        ?.auth_version,
    ).toBe(2);
  });

  it("changes the normalized username with reauthentication and revokes sessions", async () => {
    const grant = await setup();
    await service.updateUsername(grant.token, {
      username: "New_Owner",
      currentPassword: fixturePassword,
      expectedVersion: 1,
    });
    expect(await service.getSession(grant.token)).toBeNull();
    await expect(login()).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await service.login(
          { username: "new_owner", password: fixturePassword },
          ip(),
        )
      ).session.user,
    ).toEqual({ id: 1, username: "new_owner", version: 2 });
    await expect(
      env.DB.prepare("UPDATE administrators SET username='unsafe'").run(),
    ).rejects.toThrow("administrator_version_required");
    await expect(
      env.DB.prepare(
        "INSERT INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(2,'second','invalid',1,1)",
      ).run(),
    ).rejects.toThrow("CHECK");
  });
});
