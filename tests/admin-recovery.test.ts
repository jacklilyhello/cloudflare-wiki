import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { recoveryStatement } from "../shared/admin-recovery";
import { hashPassword, sha256 } from "../worker/auth/crypto";
import { AuthService } from "../worker/auth/service";

const oldPassword = "isolated-old-password-only";
const newPassword = "isolated-new-password-only";
let newHash: string;
const auth = new AuthService(env.DB);
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(1,'owner',?,?,?)",
  )
    .bind(await hashPassword(oldPassword), now, now)
    .run();
  await env.DB.prepare("INSERT INTO admin_bootstrap VALUES(1,?,?,?)")
    .bind("a".repeat(64), now - 1000, now - 2000)
    .run();
  newHash = await hashPassword(newPassword);
});
async function recovery(token = "synthetic-recovery-fixture") {
  return recoveryStatement({
    passwordHash: newHash,
    requestHash: await sha256(token),
    expectedVersion: 1,
    expiresAt: Date.now() + 60000,
  });
}
async function apply(plan: ReturnType<typeof recoveryStatement>) {
  return env.DB.prepare(plan.sql)
    .bind(...plan.params)
    .all();
}
it("recovers only the original administrator, revokes all sessions, keeps setup closed and records no secrets", async () => {
  const old = await auth.login(
    { username: "owner", password: oldPassword },
    "1".repeat(64),
  );
  const plan = await recovery();
  expect((await apply(plan)).results).toEqual([{ id: 1, auth_version: 2 }]);
  expect(
    (
      await env.DB.prepare(
        "SELECT id,username,auth_version FROM administrators",
      ).all()
    ).results,
  ).toEqual([{ id: 1, username: "owner", auth_version: 2 }]);
  const oldResponse = await exports.default.fetch(
    "https://example.com/api/admin/session",
    { headers: { Cookie: `__Host-wiki_session=${old.token}` } },
  );
  expect(oldResponse.status).toBe(401);
  await expect(
    auth.login({ username: "owner", password: oldPassword }, "2".repeat(64)),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    (
      await auth.login(
        { username: "owner", password: newPassword },
        "3".repeat(64),
      )
    ).session.user,
  ).toEqual({ id: 1, username: "owner", version: 2 });
  await expect(
    auth.login(
      { username: "other-owner", password: newPassword },
      "4".repeat(64),
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(await auth.bootstrapStatus()).toEqual({
    initialized: true,
    setupAvailable: false,
  });
  const audit = (
    await env.DB.prepare(
      "SELECT action,details_json FROM audit_records WHERE category='administrator' ORDER BY seq",
    ).all()
  ).results;
  expect(audit).toContainEqual({
    action: "administrator.credentials",
    details_json: '{"usernameChanged":false,"passwordChanged":true}',
  });
  for (const secret of [
    oldPassword,
    newPassword,
    newHash,
    "synthetic-recovery-fixture",
    old.token,
  ])
    expect(JSON.stringify(audit)).not.toContain(secret);
  const count = await env.DB.prepare(
    "SELECT count(*) AS n FROM administrator_recoveries",
  ).first();
  expect(count?.n).toBe(1);
  expect((await apply(plan)).results).toEqual([]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM administrator_recoveries",
    ).first(),
  ).toEqual(count);
});
it("allows only one concurrent recovery and rejects stale or database-expired plans", async () => {
  const first = await recovery("first");
  const second = await recovery("second");
  const results = await Promise.all([apply(first), apply(second)]);
  expect(results.reduce((n, result) => n + result.results.length, 0)).toBe(1);
  expect((await apply(first)).results).toEqual([]);
  expect((await apply(second)).results).toEqual([]);
  const expired = recoveryStatement({
    passwordHash: newHash,
    requestHash: "b".repeat(64),
    expectedVersion: 2,
    expiresAt: Date.now() + 60000,
  });
  // Simulate a valid prepared request arriving after its expiry, independently
  // of the Actions-side validation. The database checks its own current time.
  expired.params[4] = Date.now() - 1000;
  expired.params[5] = Date.now() - 1000;
  expect((await apply(expired)).results).toEqual([]);
});
it("rolls back credentials, sessions and audit if a recovery side effect fails", async () => {
  await auth.login(
    { username: "owner", password: oldPassword },
    "5".repeat(64),
  );
  const before = (await env.DB.prepare("SELECT * FROM administrators").all())
    .results;
  const sessions = (await env.DB.prepare("SELECT * FROM admin_sessions").all())
    .results;
  const audit = (await env.DB.prepare("SELECT * FROM audit_records").all())
    .results;
  await env.DB.exec(
    "CREATE TRIGGER fixture_recovery_failure BEFORE INSERT ON administrator_recoveries BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  await expect(apply(await recovery())).rejects.toThrow();
  expect(
    (await env.DB.prepare("SELECT * FROM administrators").all()).results,
  ).toEqual(before);
  expect(
    (await env.DB.prepare("SELECT * FROM admin_sessions").all()).results,
  ).toEqual(sessions);
  expect(
    (await env.DB.prepare("SELECT * FROM audit_records").all()).results,
  ).toEqual(audit);
});
it("exposes no anonymous reset endpoint and cannot create another administrator", async () => {
  const response = await exports.default.fetch(
    "https://example.com/api/admin/recovery",
    { method: "POST" },
  );
  expect(response.status).toBe(401);
  await expect(
    env.DB.prepare(
      "INSERT INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(2,'other','invalid',1,1)",
    ).run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "UPDATE administrators SET username='other',password_hash=?,auth_version=2,recovery_request_hash=? WHERE id=1",
    )
      .bind(newHash, "c".repeat(64))
      .run(),
  ).rejects.toThrow();
});
