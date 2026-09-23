import assert from "node:assert/strict";
import { test } from "node:test";
import {
  D1_BINDING,
  D1_MARKER,
  D1_NAME,
  LOCAL_D1_ID,
  resolveD1Config,
  validateDatabase,
  validateMigrationNames,
  verifyWorkerD1Binding,
} from "../scripts/d1-policy.mjs";
import { inspectD1, provisionD1 } from "../scripts/d1-provision.mjs";

const databaseId = "11111111-2222-4333-8444-555555555555";
const database = { name: D1_NAME, uuid: databaseId };
const migrations = ["0001_project.sql", "0002_content.sql"];
const env = {
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
const config = {
  name: "cloudflare-wiki",
  d1_databases: [
    {
      binding: D1_BINDING,
      database_name: D1_NAME,
      database_id: LOCAL_D1_ID,
      migrations_dir: "migrations",
      remote: false,
    },
  ],
};
const input = {
  env,
  config,
  configPath: "/project/dist/cloudflare_wiki/wrangler.json",
  migrationsDirectory: "/project/migrations",
  migrationNames: migrations,
};

function harness(options = {}) {
  const calls = [];
  const writes = [];
  const commands = [];
  let marker =
    options.marker === undefined ? [{ ...D1_MARKER }] : options.marker;
  let ledger = options.ledger ?? [...migrations];
  const response = (result, status = 200) =>
    new Response(JSON.stringify({ success: true, result }), { status });
  const dependencies = {
    async fetch(url, init) {
      const body = init.body ? JSON.parse(init.body) : undefined;
      const call = { url: new URL(url), method: init.method, body };
      calls.push(call);
      assert.equal(call.url.origin, "https://api.cloudflare.com");
      assert.equal(init.redirect, "error");
      const overridden = await options.onRequest?.(call);
      if (overridden) return overridden;
      if (init.method === "GET")
        return response(options.databases ?? [database]);
      if (call.url.pathname.endsWith("/database")) return response(database);
      assert.ok(call.url.pathname.endsWith(`/${databaseId}/query`));
      assert.match(body.sql, /^SELECT /);
      let rows;
      if (body.sql.includes("sqlite_schema"))
        rows = marker === null ? [] : [{ name: "project_metadata" }];
      else if (body.sql.includes("FROM project_metadata")) rows = marker;
      else if (body.sql.includes("FROM d1_migrations"))
        rows = ledger.map((name) => ({ name }));
      else assert.fail("Unexpected verification SQL");
      return response([{ success: true, results: rows }]);
    },
    async writeConfig(value) {
      writes.push(value);
    },
    async runWrangler(args) {
      commands.push(args);
      if (options.migrationError)
        throw new Error("Simulated migration failure");
      marker = [{ ...D1_MARKER }];
      ledger = options.afterMigrations ?? [...migrations];
    },
  };
  return { calls, writes, commands, dependencies };
}

function assertInspectionOnly(h) {
  assert.equal(h.writes.length + h.commands.length, 0);
  assert.ok(
    h.calls.every(
      (call) =>
        call.method === "GET" ||
        (call.method === "POST" &&
          call.url.pathname.endsWith("/query") &&
          call.body.sql.startsWith("SELECT ")),
    ),
  );
}

test("inspection reports an absent database without creating it or writing configuration", async () => {
  const h = harness({ databases: [] });
  assert.deepEqual(await inspectD1(input, h.dependencies), {
    state: "absent",
    appliedCount: 0,
    expectedNames: migrations,
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assertInspectionOnly(h);
});

for (const ledger of [[migrations[0]], migrations]) {
  test(`inspection verifies an owned database with ${ledger.length} applied migrations without applying pending ones`, async () => {
    const h = harness({ ledger });
    assert.deepEqual(await inspectD1(input, h.dependencies), {
      state: "owned",
      databaseId,
      appliedCount: ledger.length,
      expectedNames: migrations,
    });
    assert.equal(h.calls.length, 4);
    assert.ok(h.calls.at(-1).body.sql.includes("FROM d1_migrations"));
    assertInspectionOnly(h);
  });
}

for (const [label, options, expected] of [
  ["absent ownership marker", { marker: null }, /ownership marker/],
  [
    "foreign ownership marker",
    { marker: [{ ...D1_MARKER, app_id: "other/project" }] },
    /ownership marker/,
  ],
  ["empty migration ledger", { ledger: [] }, /bootstrap migration/],
  ["non-prefix migration ledger", { ledger: [migrations[1]] }, /ledger/],
  ["ambiguous lookup", { databases: [database, database] }, /ambiguous/],
  [
    "invalid database identifier",
    { databases: [{ ...database, uuid: LOCAL_D1_ID }] },
    /identifier/,
  ],
]) {
  test(`inspection rejects ${label} without any mutation`, async () => {
    const h = harness(options);
    await assert.rejects(inspectD1(input, h.dependencies), expected);
    assertInspectionOnly(h);
  });
}

test("inspection checks deployment and source configuration before requesting the account", async () => {
  for (const override of [
    { env: { ...env, GITHUB_ACTIONS: "false" } },
    { config: { ...config, name: "other-worker" } },
    { configPath: "wrangler.json" },
    { migrationsDirectory: "migrations" },
    { migrationNames: ["0002_content.sql"] },
  ]) {
    const h = harness();
    await assert.rejects(inspectD1({ ...input, ...override }, h.dependencies));
    assert.equal(h.calls.length, 0);
    assertInspectionOnly(h);
  }
});

test("inspection refuses to replace a conflicting Worker binding for absent or owned databases", async () => {
  for (const databases of [[], [database]]) {
    const h = harness({ databases });
    await assert.rejects(
      inspectD1(
        {
          ...input,
          workerSettings: {
            bindings: [
              {
                type: "d1",
                name: "DB",
                database_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              },
            ],
          },
        },
        h.dependencies,
      ),
      /Worker DB binding/,
    );
    assert.equal(h.calls.length, 1);
    assertInspectionOnly(h);
  }
});

test("provisioning looks up again and adopts only verified ownership after an earlier absent inspection", async () => {
  let lookups = 0;
  const h = harness({
    onRequest: (call) => {
      if (call.method === "GET")
        return new Response(
          JSON.stringify({
            success: true,
            result: ++lookups === 1 ? [] : [database],
          }),
        );
    },
  });
  assert.equal((await inspectD1(input, h.dependencies)).state, "absent");
  const result = await provisionD1(input, h.dependencies);
  assert.equal(result.databaseId, databaseId);
  assert.equal(lookups, 2);
  assert.equal(h.calls.filter((call) => call.body?.name).length, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.commands.length, 0);
});

test("provisioning rechecks ownership instead of trusting an earlier successful inspection", async () => {
  let markerChanged = false;
  const h = harness({
    ledger: [migrations[0]],
    onRequest: (call) => {
      if (markerChanged && call.body?.sql.includes("FROM project_metadata"))
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                success: true,
                results: [{ ...D1_MARKER, app_id: "other/project" }],
              },
            ],
          }),
        );
    },
  });
  assert.equal((await inspectD1(input, h.dependencies)).state, "owned");
  markerChanged = true;
  await assert.rejects(provisionD1(input, h.dependencies), /ownership marker/);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 2);
  assertInspectionOnly(h);
});

test("creates and migrates one fixed database after a conclusive empty lookup", async () => {
  const h = harness({ databases: [], marker: null, ledger: [] });
  const result = await provisionD1(input, h.dependencies);
  assert.equal(result.databaseId, databaseId);
  assert.equal(
    h.calls.filter(
      (call) =>
        call.url.pathname.endsWith("/database") && call.method === "POST",
    ).length,
    1,
  );
  assert.deepEqual(h.calls[1].body, { name: D1_NAME });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].d1_databases, [
    {
      binding: "DB",
      database_name: D1_NAME,
      database_id: databaseId,
      migrations_dir: "/project/migrations",
      remote: false,
    },
  ]);
  assert.deepEqual(h.commands, [
    [
      "d1",
      "migrations",
      "apply",
      D1_NAME,
      "--remote",
      "--config",
      input.configPath,
      "--experimental-provision=false",
      "--experimental-auto-create=false",
    ],
  ]);
  assert.ok(h.calls.at(-1).body.sql.includes("FROM d1_migrations"));
});

test("reuses a marked fully migrated database without another cloud write", async () => {
  const h = harness();
  await provisionD1(input, h.dependencies);
  assert.equal(h.commands.length, 0);
  assert.ok(
    h.calls.every(
      (call) => call.method === "GET" || call.body.sql.startsWith("SELECT "),
    ),
  );
  assert.equal(h.writes.length, 1);
});

test("resumes a verified migration prefix without recreating or remarking the database", async () => {
  const h = harness({ ledger: [migrations[0]] });
  await provisionD1(input, h.dependencies);
  assert.equal(h.commands.length, 1);
  assert.equal(h.calls.filter((call) => call.body?.name).length, 0);
});

for (const [label, override] of [
  ["local execution", { env: { ...env, GITHUB_ACTIONS: "false" } }],
  ["pull request", { env: { ...env, GITHUB_EVENT_NAME: "pull_request" } }],
  ["other branch", { env: { ...env, GITHUB_REF: "refs/heads/feature/test" } }],
  ["production", { env: { ...env, TEST_DOMAIN: "emby.wiki" } }],
  ["unexpected built Worker", { config: { ...config, name: "other-worker" } }],
  ["relative migration path", { migrationsDirectory: "migrations" }],
  ["relative config path", { configPath: "wrangler.json" }],
  ["missing marker migration", { migrationNames: ["0002_content.sql"] }],
  ["path traversal", { migrationNames: ["../0001_project.sql"] }],
  [
    "real source ID",
    {
      config: {
        ...config,
        d1_databases: [{ ...config.d1_databases[0], database_id: databaseId }],
      },
    },
  ],
  [
    "remote local binding",
    {
      config: {
        ...config,
        d1_databases: [{ ...config.d1_databases[0], remote: true }],
      },
    },
  ],
  [
    "extra database",
    {
      config: {
        ...config,
        d1_databases: [...config.d1_databases, config.d1_databases[0]],
      },
    },
  ],
]) {
  test(`rejects ${label} before any side effect`, async () => {
    const h = harness();
    await assert.rejects(
      provisionD1({ ...input, ...override }, h.dependencies),
    );
    assert.equal(h.calls.length + h.writes.length + h.commands.length, 0);
  });
}

for (const [label, marker] of [
  ["absent table", null],
  ["empty marker", []],
  ["different project", [{ ...D1_MARKER, app_id: "other/project" }]],
  ["production marker", [{ ...D1_MARKER, environment: "production" }]],
  ["different name", [{ ...D1_MARKER, database_name: "another-db" }]],
  ["duplicate marker rows", [D1_MARKER, D1_MARKER]],
]) {
  test(`does not adopt a pre-existing database with ${label}`, async () => {
    const h = harness({ marker });
    await assert.rejects(
      provisionD1(input, h.dependencies),
      /ownership marker/,
    );
    assert.equal(h.writes.length + h.commands.length, 0);
    assert.equal(h.calls.filter((call) => call.body?.name).length, 0);
  });
}

for (const ledger of [
  [],
  [migrations[1]],
  [migrations[0], "0003_unknown.sql"],
  [migrations[0], migrations[0]],
]) {
  test(`rejects an inconsistent existing ledger ${JSON.stringify(ledger)}`, async () => {
    const h = harness({ ledger });
    await assert.rejects(
      provisionD1(input, h.dependencies),
      /ledger|bootstrap migration/,
    );
    assert.equal(h.writes.length + h.commands.length, 0);
  });
}

test("does not infer successful migrations from the child process exit status", async () => {
  const h = harness({
    ledger: [migrations[0]],
    afterMigrations: [migrations[0]],
  });
  await assert.rejects(provisionD1(input, h.dependencies), /ledger/);
  assert.equal(h.commands.length, 1);
});

test("does not retry a failed migration", async () => {
  const h = harness({ ledger: [migrations[0]], migrationError: true });
  await assert.rejects(provisionD1(input, h.dependencies), /migration failure/);
  assert.equal(h.commands.length, 1);
});

test("does not retry or assume ownership after an unknown creation outcome", async () => {
  const h = harness({
    databases: [],
    onRequest: (call) => {
      if (call.method === "POST") throw new Error("sensitive upstream detail");
    },
  });
  await assert.rejects(provisionD1(input, h.dependencies), (error) => {
    assert.match(error.message, /outcome may be unknown/);
    assert.ok(!error.message.includes("sensitive upstream detail"));
    return true;
  });
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("permission denial stops without exposing upstream response or retrying", async () => {
  const h = harness({
    onRequest: () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "sensitive upstream detail" }],
        }),
        { status: 403 },
      ),
  });
  await assert.rejects(provisionD1(input, h.dependencies), (error) => {
    assert.match(error.message, /HTTP 403; API codes: 10000/);
    assert.ok(!error.message.includes("sensitive upstream detail"));
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("rejects HTTP 200 with a failed SQL result", async () => {
  const h = harness({
    onRequest: (call) =>
      call.body?.sql
        ? new Response(
            JSON.stringify({
              success: true,
              result: [{ success: false, results: [] }],
            }),
          )
        : undefined,
  });
  await assert.rejects(provisionD1(input, h.dependencies), /successful result/);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("rejects an unsuccessful API envelope even with HTTP 200", async () => {
  const h = harness({
    onRequest: () =>
      new Response(JSON.stringify({ success: false, result: [] })),
  });
  await assert.rejects(provisionD1(input, h.dependencies), /HTTP 200/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("creation permission failure is not retried or followed by migrations", async () => {
  const h = harness({
    databases: [],
    onRequest: (call) =>
      call.method === "POST"
        ? new Response(
            JSON.stringify({ success: false, errors: [{ code: 10000 }] }),
            { status: 403 },
          )
        : undefined,
  });
  await assert.rejects(
    provisionD1(input, h.dependencies),
    /D1 creation failed: HTTP 403/,
  );
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("an unexpected creation identifier never reaches migration or configuration", async () => {
  const h = harness({
    databases: [],
    onRequest: (call) =>
      call.method === "POST"
        ? new Response(
            JSON.stringify({
              success: true,
              result: { ...database, uuid: LOCAL_D1_ID },
            }),
          )
        : undefined,
  });
  await assert.rejects(provisionD1(input, h.dependencies), /identifier/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("paginates name searches and requires an exact database name", async () => {
  const h = harness({
    onRequest: (call) => {
      if (call.method !== "GET") return;
      const firstPage = call.url.searchParams.get("page") === "1";
      return new Response(
        JSON.stringify({
          success: true,
          result: firstPage
            ? Array.from({ length: 100 }, (_, index) => ({
                name: `${D1_NAME}-${index}`,
                uuid: databaseId,
              }))
            : [database],
        }),
      );
    },
  });
  await provisionD1(input, h.dependencies);
  assert.equal(h.calls.filter((call) => call.method === "GET").length, 2);
  assert.equal(h.commands.length, 0);
});

test("rejects ambiguous duplicate database lookup results", async () => {
  const h = harness({ databases: [database, database] });
  await assert.rejects(provisionD1(input, h.dependencies), /ambiguous/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes.length + h.commands.length, 0);
});

test("refuses to replace an existing Worker database binding", async () => {
  for (const databases of [[], [database]]) {
    const h = harness({ databases });
    await assert.rejects(
      provisionD1(
        {
          ...input,
          workerSettings: {
            bindings: [
              {
                type: "d1",
                name: "DB",
                database_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              },
            ],
          },
        },
        h.dependencies,
      ),
      /Worker DB binding/,
    );
    assert.equal(h.calls.length, 1);
    assert.equal(h.writes.length + h.commands.length, 0);
  }
});

test("rejects unexpected database identities and unsafe binding configuration", () => {
  for (const value of [LOCAL_D1_ID, "not-a-uuid", undefined])
    assert.throws(() => validateDatabase({ name: D1_NAME, uuid: value }));
  assert.throws(() => validateDatabase({ ...database, name: "other" }));
  assert.throws(() => resolveD1Config(config, databaseId, "migrations"));
  assert.throws(() =>
    validateMigrationNames(["0001_project.sql", "0001_other.sql"]),
  );
});

test("deployed Worker readback must contain exactly the verified DB binding", () => {
  const binding = { type: "d1", name: "DB", database_id: databaseId };
  assert.doesNotThrow(() =>
    verifyWorkerD1Binding({ bindings: [binding] }, databaseId),
  );
  assert.doesNotThrow(() =>
    verifyWorkerD1Binding(
      { bindings: [{ type: "d1", name: "DB", id: databaseId }] },
      databaseId,
    ),
  );
  for (const bindings of [
    [],
    [binding, binding],
    [{ ...binding, database_id: LOCAL_D1_ID }],
    [{ ...binding, name: "OTHER" }],
    [{ ...binding, type: "plain_text" }],
    [{ ...binding, id: LOCAL_D1_ID }],
  ])
    assert.throws(() => verifyWorkerD1Binding({ bindings }, databaseId));
});
