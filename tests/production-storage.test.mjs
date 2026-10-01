import assert from "node:assert/strict";
import { test } from "node:test";
import { D1_MARKER, D1_NAME, LOCAL_D1_ID } from "../scripts/d1-policy.mjs";
import { productionStorage } from "../scripts/production-storage.mjs";
import { R2_BUCKET, R2_OWNER, R2_OWNER_KEY } from "../scripts/r2-policy.mjs";

const databaseId = "11111111-2222-4333-8444-555555555555";
const migrations = ["0001_project.sql", "0002_content.sql"];
const input = {
  env: {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: "a".repeat(40),
    CLOUDFLARE_API_TOKEN: "fixture-only",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    CLOUDFLARE_ZONE_ID: "c".repeat(32),
    CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
    PRODUCTION_DOMAIN: "emby.wiki",
  },
  config: {
    name: "cloudflare-wiki",
    d1_databases: [
      {
        binding: "DB",
        database_name: D1_NAME,
        database_id: LOCAL_D1_ID,
        remote: false,
      },
    ],
    r2_buckets: [{ binding: "MEDIA", bucket_name: R2_BUCKET, remote: false }],
  },
  configPath: "/project/dist/cloudflare_wiki/wrangler.json",
  migrationsDirectory: "/project/migrations",
  migrationNames: migrations,
  workerSettings: {
    bindings: [
      { name: "APP_ID", type: "plain_text", text: R2_OWNER.app_id },
      { name: "DB", type: "d1", id: databaseId },
      { name: "MEDIA", type: "r2_bucket", bucket_name: R2_BUCKET },
    ],
  },
};

function harness(options = {}) {
  const calls = [];
  const response = (result) => Response.json({ success: true, result });
  return {
    calls,
    async fetch(url, init) {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, method: init.method, sql: body?.sql });
      assert.equal(new URL(url).origin, "https://api.cloudflare.com");
      assert.equal(init.redirect, "error");
      if (path.includes("/d1/")) {
        if (init.method === "GET")
          return response(
            options.absentD1 ? [] : [{ name: D1_NAME, uuid: databaseId }],
          );
        assert.equal(init.method, "POST");
        assert.match(
          body?.sql ?? "",
          /^SELECT /,
          "Only SELECT queries may reach D1",
        );
        if (body.sql.includes("sqlite_schema"))
          return response([
            { success: true, results: [{ name: "project_metadata" }] },
          ]);
        if (body.sql.includes("FROM project_metadata"))
          return response([
            { success: true, results: [options.badD1Marker ? {} : D1_MARKER] },
          ]);
        if (body.sql.includes("FROM d1_migrations"))
          return response([
            {
              success: true,
              results: (options.pending
                ? migrations.slice(0, 1)
                : migrations
              ).map((name) => ({ name })),
            },
          ]);
        assert.fail("Unexpected D1 query");
      }
      assert.equal(init.method, "GET", "R2 must never be mutated");
      if (path.endsWith("/buckets"))
        return response({
          buckets: options.absentR2 ? [] : [{ name: R2_BUCKET }],
        });
      if (path.endsWith(`/objects/${R2_OWNER_KEY}`))
        return Response.json(options.badR2Marker ? {} : R2_OWNER);
      if (path.endsWith("/domains/managed"))
        return response({ enabled: options.publicR2 ?? false });
      if (path.endsWith("/domains/custom"))
        return response({ domains: options.customR2 ? [{}] : [] });
      assert.fail("Unexpected API path");
    },
  };
}

test("production keeps the original D1/R2 and ownership markers using only read requests", async () => {
  const h = harness();
  const result = await productionStorage(input, h);
  assert.equal(result.databaseId, databaseId);
  assert.equal(result.config.d1_databases[0].database_id, databaseId);
  assert.equal(result.config.d1_databases[0].database_name, D1_NAME);
  assert.deepEqual(result.config.r2_buckets, input.config.r2_buckets);
  assert.ok(
    h.calls.every(
      (call) => call.method === "GET" || call.sql.startsWith("SELECT "),
    ),
  );
});
for (const options of [
  { absentD1: true },
  { pending: true },
  { badD1Marker: true },
  { absentR2: true },
  { badR2Marker: true },
  { publicR2: true },
  { customR2: true },
]) {
  test(`production stops without creation, migration or writes: ${Object.keys(options)[0]}`, async () => {
    const h = harness(options);
    await assert.rejects(productionStorage(input, h));
    assert.ok(
      h.calls.every(
        (call) => call.method === "GET" || call.sql.startsWith("SELECT "),
      ),
    );
  });
}
test("production requires all original Worker bindings without provisioning replacements", async () => {
  for (const name of ["APP_ID", "DB", "MEDIA"]) {
    const h = harness();
    await assert.rejects(
      productionStorage(
        {
          ...input,
          workerSettings: {
            bindings: input.workerSettings.bindings.filter(
              (binding) => binding.name !== name,
            ),
          },
        },
        h,
      ),
    );
  }
});
