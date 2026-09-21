import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  bootstrapAdmin,
  prepareAdminBootstrap,
} from "../scripts/admin-bootstrap.mjs";

const validEnv = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: "a".repeat(40),
  CLOUDFLARE_API_TOKEN: "test-only-placeholder",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  CLOUDFLARE_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
  TEST_DOMAIN: "cf.emby.wiki",
};
const databaseId = "12345678-1234-1234-1234-123456789abc";
const testToken = Buffer.alloc(32, 7).toString("base64url");
const tokenHash = prepareAdminBootstrap({
  ...validEnv,
  ADMIN_SETUP_TOKEN: testToken,
});
const rotatedHash = prepareAdminBootstrap({
  ...validEnv,
  ADMIN_SETUP_TOKEN: Buffer.alloc(32, 9).toString("base64url"),
});
const now = 1_800_000_000_000;
const day = 86_400_000;

function harness(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../migrations/0004_administrator.sql", import.meta.url),
      "utf8",
    ),
  );
  t.after(() => db.close());
  const calls = [];
  const input = { env: validEnv, databaseId, tokenHash };
  const dependencies = {
    now: () => now,
    async fetch(url, init) {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      const results = db.prepare(body.sql).all(...body.params);
      const { changes } = db.prepare("SELECT changes() AS changes").get();
      return Response.json({
        success: true,
        result: [{ success: true, results, meta: { changes } }],
      });
    },
  };
  return {
    db,
    calls,
    input,
    dependencies,
    row: () => db.prepare("SELECT * FROM admin_bootstrap WHERE id=1").get(),
    seedAdmin() {
      db.prepare(
        "INSERT INTO administrators(id,username,password_hash,auth_version,created_at,updated_at) VALUES(1,'owner',?,1,?,?)",
      ).run("test-only-password-digest", now, now);
    },
    run: (overrides = {}, hooks = {}) =>
      bootstrapAdmin({ ...input, ...overrides }, { ...dependencies, ...hooks }),
  };
}

test("optional absent setup secret produces no bootstrap request", async (t) => {
  const h = harness(t);
  for (const token of [undefined, ""]) {
    const hash = prepareAdminBootstrap({
      ...validEnv,
      ADMIN_SETUP_TOKEN: token,
    });
    assert.equal(hash, null);
    assert.equal(await h.run({ tokenHash: hash }), "not-configured");
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.row(), undefined);
});

test("accepts canonical 32-byte and longer secrets and hashes their original text", () => {
  for (const size of [32, 48, 192]) {
    const token = Buffer.alloc(size, 7).toString("base64url");
    assert.equal(
      prepareAdminBootstrap({ ...validEnv, ADMIN_SETUP_TOKEN: token }),
      createHash("sha256").update(token).digest("hex"),
    );
  }
});

test("rejects short, malformed, padded, noncanonical, or excessive setup secrets", () => {
  for (const token of [
    "short",
    "a".repeat(42),
    "a".repeat(43),
    `${testToken}=`,
    `${testToken}\n`,
    ` ${testToken}`,
    `${testToken}+`,
    "a".repeat(257),
    42,
  ]) {
    assert.throws(
      () => prepareAdminBootstrap({ ...validEnv, ADMIN_SETUP_TOKEN: token }),
      /ADMIN_SETUP_TOKEN must encode/,
    );
  }
});

for (const [key, value] of Object.entries({
  GITHUB_ACTIONS: "false",
  GITHUB_REPOSITORY: "other/repository",
  GITHUB_REF: "refs/heads/feature/admin-auth",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_SHA: "invalid",
  TEST_DOMAIN: "emby.wiki",
  CLOUDFLARE_WORKER_NAME: "other-worker",
  CLOUDFLARE_ACCOUNT_ID: "invalid",
  CLOUDFLARE_API_TOKEN: "",
})) {
  test(`rejects unsafe source/config before any effect: ${key}`, async (t) => {
    const h = harness(t);
    const env = { ...validEnv, [key]: value };
    assert.throws(() => prepareAdminBootstrap(env));
    await assert.rejects(h.run({ env }));
    assert.equal(h.calls.length, 0);
    assert.equal(h.row(), undefined);
  });
}

test("creates one 24-hour bootstrap using hash-only SQL parameters", async (t) => {
  const h = harness(t);
  assert.equal(await h.run(), "configured");
  assert.deepEqual(
    { ...h.row() },
    {
      id: 1,
      token_hash: tokenHash,
      expires_at: now + day,
      consumed_at: null,
    },
  );
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(
    url,
    `https://api.cloudflare.com/client/v4/accounts/${validEnv.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
  );
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.equal(
    init.headers.Authorization,
    `Bearer ${validEnv.CLOUDFLARE_API_TOKEN}`,
  );
  assert.deepEqual(JSON.parse(init.body).params, [tokenHash, now + day]);
  assert.ok(!JSON.stringify(h.calls).includes(testToken));
});

test("same-token deployment never extends an active or expired bootstrap window", async (t) => {
  const h = harness(t);
  await h.run();
  const original = h.row();
  for (const time of [now + 1_000, now + day, now + 2 * day]) {
    assert.equal(await h.run({}, { now: () => time }), "unchanged");
    assert.deepEqual(h.row(), original);
  }
});

test("a changed secret rotates an unconsumed setup, including after expiry", async (t) => {
  const h = harness(t);
  await h.run();
  assert.equal(
    await h.run({ tokenHash: rotatedHash }, { now: () => now + 2 * day }),
    "configured",
  );
  assert.equal(h.row().token_hash, rotatedHash);
  assert.equal(h.row().expires_at, now + 3 * day);
  assert.equal(h.row().consumed_at, null);
});

test("consumed setup never rotates or reopens even without an administrator row", async (t) => {
  const h = harness(t);
  await h.run();
  h.db
    .prepare("UPDATE admin_bootstrap SET consumed_at=? WHERE id=1")
    .run(now + 10);
  const consumed = h.row();
  assert.equal(await h.run({ tokenHash: rotatedHash }), "unchanged");
  assert.deepEqual(h.row(), consumed);
});

test("an existing administrator prevents bootstrap creation and updates", async (t) => {
  const h = harness(t);
  h.seedAdmin();
  assert.equal(await h.run(), "unchanged");
  assert.equal(h.row(), undefined);
  h.db
    .prepare(
      "INSERT INTO admin_bootstrap(id,token_hash,expires_at,consumed_at) VALUES(1,?,?,NULL)",
    )
    .run(tokenHash, now - day);
  const previous = h.row();
  assert.equal(await h.run({ tokenHash: rotatedHash }), "unchanged");
  assert.deepEqual(h.row(), previous);
});

test("the mutation itself guards setup completed after deployment preparation", async (t) => {
  const h = harness(t);
  const result = await h.run(
    {},
    {
      fetch: (url, init) => {
        h.seedAdmin();
        return h.dependencies.fetch(url, init);
      },
    },
  );
  assert.equal(result, "unchanged");
  assert.equal(h.row(), undefined);
  assert.equal(h.calls.length, 1);
});

test("invalid IDs, hashes, and clocks are rejected before transport", async (t) => {
  const h = harness(t);
  for (const input of [
    { databaseId: "00000000-0000-0000-0000-000000000000" },
    { databaseId: "invalid/other" },
    { tokenHash: testToken },
    { tokenHash: "A".repeat(64) },
    { tokenHash: undefined },
  ])
    await assert.rejects(h.run(input));
  for (const time of [NaN, -1, Number.MAX_SAFE_INTEGER])
    await assert.rejects(h.run({}, { now: () => time }));
  assert.equal(h.calls.length, 0);
});

test("an unknown write outcome is sanitized and never retried", async (t) => {
  const h = harness(t);
  let attempts = 0;
  await assert.rejects(
    h.run(
      {},
      {
        async fetch() {
          attempts++;
          throw new Error(`private upstream ${testToken} ${tokenHash}`);
        },
      },
    ),
    (error) => {
      assert.match(error.message, /outcome may be unknown/);
      assert.ok(!error.message.includes(testToken));
      assert.ok(!error.message.includes(tokenHash));
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("a lost response after a committed write does not get retried or extend expiry", async (t) => {
  const h = harness(t);
  await assert.rejects(
    h.run(
      {},
      {
        async fetch(url, init) {
          await h.dependencies.fetch(url, init);
          throw new Error("connection lost");
        },
      },
    ),
  );
  assert.equal(h.calls.length, 1);
  const first = h.row();
  assert.equal(await h.run({}, { now: () => now + day }), "unchanged");
  assert.deepEqual(h.row(), first);
});

for (const [name, response] of [
  [
    "forbidden",
    () =>
      Response.json(
        { success: false, errors: [{ code: 10000, message: tokenHash }] },
        { status: 403 },
      ),
  ],
  [
    "HTTP success with API failure",
    () => Response.json({ success: false, errors: [{ code: testToken }] }),
  ],
  ["invalid JSON", () => new Response(tokenHash)],
  ["missing result", () => Response.json({ success: true })],
  ["empty result", () => Response.json({ success: true, result: [] })],
  [
    "failed query",
    () =>
      Response.json({
        success: true,
        result: [{ success: false, results: [], error: testToken }],
      }),
  ],
  [
    "multiple results",
    () =>
      Response.json({
        success: true,
        result: [
          { success: true, results: [], meta: { changes: 0 } },
          { success: true, results: [], meta: { changes: 0 } },
        ],
      }),
  ],
  [
    "missing changes",
    () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [] }],
      }),
  ],
  [
    "missing returning row",
    () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [], meta: { changes: 1 } }],
      }),
  ],
  [
    "wrong returning row",
    () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [{ id: 2 }], meta: { changes: 1 } }],
      }),
  ],
]) {
  test(`rejects ${name} without exposing credentials or retrying`, async (t) => {
    const h = harness(t);
    let attempts = 0;
    await assert.rejects(
      h.run(
        {},
        {
          async fetch() {
            attempts++;
            return response();
          },
        },
      ),
      (error) => {
        assert.ok(!error.message.includes(testToken));
        assert.ok(!error.message.includes(tokenHash));
        return true;
      },
    );
    assert.equal(attempts, 1);
  });
}
