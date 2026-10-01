import assert from "node:assert/strict";
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { scryptSync } from "node:crypto";
import { test } from "node:test";
import {
  parseRecoveryBundle,
  prepareRecovery,
  recoverAdministrator,
  validateRecoveryContext,
} from "../scripts/administrator-recovery.mjs";
import { verifyRecoveryEnvironment } from "../scripts/recovery-protection.mjs";
import { prepareRecoveryFile } from "../scripts/prepare-admin-recovery.mjs";

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF:
    "jacklilyhello/cloudflare-wiki/.github/workflows/administrator-recovery.yml@refs/heads/main",
  RECOVERY_ENVIRONMENT: "administrator-recovery",
  RECOVERY_OPERATION: "apply",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  CLOUDFLARE_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
  PRODUCTION_DOMAIN: "emby.wiki",
  CLOUDFLARE_API_TOKEN: "test-only-placeholder",
};
const databaseId = "12345678-1234-1234-1234-123456789abc";
function bundle() {
  return {
    password: "synthetic-new-password-only",
    token: Buffer.alloc(32, 8).toString("base64url"),
    expectedVersion: 1,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
}
function harness(t) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  db.prepare(
    "INSERT INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(1,'owner','unusable-fixture',?,?)",
  ).run(Date.now(), Date.now());
  const calls = [];
  const fetchRequest = async (url, init) => {
    assert.equal(
      url,
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
    );
    const body = JSON.parse(init.body);
    calls.push(body);
    const results = db.prepare(body.sql).all(...body.params);
    return Response.json({
      success: true,
      result: [{ success: true, results }],
    });
  };
  t.after(() => db.close());
  return { db, calls, fetchRequest };
}
test("recovery bundle is closed, bounded, expiring and compatible with the fixed Worker scrypt profile", async () => {
  const input = bundle();
  const prepared = await prepareRecovery(JSON.stringify(input));
  const parts = prepared.passwordHash.split("$");
  const expected = scryptSync(
    input.password,
    Buffer.from(parts[4], "base64url"),
    32,
    { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 },
  );
  assert.equal(parts[5], expected.toString("base64url"));
  for (const change of [
    { username: "other" },
    { password: "short" },
    { password: "x".repeat(129) },
    { token: "bad" },
    { expectedVersion: 0 },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { expiresAt: new Date(Date.now() + 2 * 86400000).toISOString() },
  ])
    assert.throws(
      () => parseRecoveryBundle(JSON.stringify({ ...input, ...change })),
      /invalid/i,
    );
  for (const value of [undefined, "", "{", "x".repeat(4097)])
    assert.throws(() => parseRecoveryBundle(value), /invalid/i);
});
test("driver is manual-main-only and status does not mutate credentials", async (t) => {
  const h = harness(t);
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/feature/test" },
    { GITHUB_WORKFLOW_REF: "wrong" },
    { RECOVERY_ENVIRONMENT: "test" },
    { RECOVERY_OPERATION: "reset" },
  ])
    assert.throws(() => validateRecoveryContext({ ...env, ...change }));
  const result = await recoverAdministrator(
    { env: { ...env, RECOVERY_OPERATION: "status" }, databaseId },
    { fetch: h.fetchRequest },
  );
  assert.deepEqual(result, { status: "ready", credentialVersion: 1 });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].sql, /^SELECT/);
});
test("driver verifies recovery readback and never repeats a consumed token", async (t) => {
  const h = harness(t);
  const input = bundle();
  const prepared = await prepareRecovery(JSON.stringify(input));
  const invoke = () =>
    recoverAdministrator(
      { env, databaseId, prepared },
      { fetch: h.fetchRequest },
    );
  assert.deepEqual(await invoke(), {
    status: "recovered",
    credentialVersion: 2,
  });
  assert.deepEqual(await invoke(), { status: "already-used" });
  assert.equal(
    h.calls.filter((call) => call.sql.startsWith("UPDATE")).length,
    1,
  );
  const transport = JSON.stringify(h.calls);
  assert.equal(transport.includes(input.password), false);
  assert.equal(transport.includes(input.token), false);
  assert.equal(
    h.db.prepare("SELECT count(*) AS n FROM administrators").get().n,
    1,
  );
});
test("ambiguous writes are sanitized and never retried automatically", async (t) => {
  const h = harness(t);
  const prepared = await prepareRecovery(JSON.stringify(bundle()));
  let mutations = 0;
  await assert.rejects(
    recoverAdministrator(
      { env, databaseId, prepared },
      {
        fetch: async (url, init) => {
          const response = await h.fetchRequest(url, init);
          if (JSON.parse(init.body).sql.startsWith("UPDATE")) {
            mutations++;
            throw new Error("sensitive-upstream-diagnostic");
          }
          return response;
        },
      },
    ),
    (error) => {
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    },
  );
  assert.equal(mutations, 1);
  assert.deepEqual(
    await recoverAdministrator(
      { env, databaseId, prepared },
      { fetch: h.fetchRequest },
    ),
    { status: "already-used" },
  );
});
test("missing environment review or an extra deployment branch fails protection verification", async () => {
  const definition = {
    name: "administrator-recovery",
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
    protection_rules: [
      {
        type: "required_reviewers",
        reviewers: [{ type: "User", reviewer: { login: "jacklilyhello" } }],
      },
    ],
  };
  const branches = {
    total_count: 1,
    branch_policies: [{ name: "main", type: "branch" }],
  };
  const inspect = (selected, policies) =>
    verifyRecoveryEnvironment("fixture-token", async (url) =>
      Response.json(
        url.includes("deployment-branch-policies") ? policies : selected,
      ),
    );
  await inspect(definition, branches);
  await assert.rejects(
    inspect({ ...definition, protection_rules: [] }, branches),
  );
  await assert.rejects(
    inspect(definition, {
      total_count: 2,
      branch_policies: [
        ...branches.branch_policies,
        { name: "*", type: "branch" },
      ],
    }),
  );
  await assert.rejects(
    inspect(definition, {
      total_count: 1,
      branch_policies: [{ name: "main", type: "tag" }],
    }),
  );
});
test("private bundle tool writes a fresh 0600 file outside the checkout and never overwrites", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wiki-recovery-fixture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const passwordFile = join(directory, "password");
  writeFileSync(passwordFile, bundle().password, { mode: 0o600 });
  const output = join(directory, "bundle");
  await prepareRecoveryFile({ passwordFile, output, expectedVersion: 1 });
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(
    parseRecoveryBundle(readFileSync(output, "utf8")).expectedVersion,
    1,
  );
  await assert.rejects(
    prepareRecoveryFile({ passwordFile, output, expectedVersion: 1 }),
  );
  await assert.rejects(
    prepareRecoveryFile({
      passwordFile,
      output: join(process.cwd(), "must-not-write-secret"),
      expectedVersion: 1,
    }),
    /outside/,
  );
});
