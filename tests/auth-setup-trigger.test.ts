import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { randomToken, sha256 } from "../worker/auth/crypto";
import { AuthService } from "../worker/auth/service";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
});

it("uses the inserted owner identity when a trigger adds other changed rows", async () => {
  await env.DB.exec(
    "CREATE TABLE setup_trigger_fixture(value TEXT); CREATE TRIGGER setup_trigger_fixture AFTER INSERT ON administrators BEGIN INSERT INTO setup_trigger_fixture VALUES('first'),('second'); END;",
  );
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO admin_bootstrap(id,token_hash,expires_at) VALUES(1,?,?)",
  )
    .bind(await sha256(token), Date.now() + 60_000)
    .run();
  const service = new AuthService(env.DB);
  // Synthetic credentials stay inside the isolated local fixture database.
  const input = {
    token,
    username: "setup-fixture",
    password: "setup-trigger-fixture-only",
  };
  const grant = await service.setup(input, "a".repeat(64));
  expect(grant.session.user.username).toBe("setup-fixture");
  expect(grant.session.user.version).toBe(1);
  expect(await service.getSession(grant.token)).not.toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS count FROM setup_trigger_fixture",
    ).first("count"),
  ).toBe(2);
  expect(
    await env.DB.prepare(
      "SELECT consumed_at FROM admin_bootstrap WHERE id=1",
    ).first("consumed_at"),
  ).not.toBeNull();
  await expect(service.setup(input, "b".repeat(64))).rejects.toMatchObject({
    status: 403,
  });
  expect(
    await env.DB.prepare("SELECT count(*) AS count FROM administrators").first(
      "count",
    ),
  ).toBe(1);
});
