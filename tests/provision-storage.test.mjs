import assert from "node:assert/strict";
import { test } from "node:test";
import { D1_MARKER, D1_NAME, LOCAL_D1_ID } from "../scripts/d1-policy.mjs";
import { provisionStorage } from "../scripts/provision-storage.mjs";
import { R2_BUCKET, R2_OWNER, R2_OWNER_KEY } from "../scripts/r2-readiness.mjs";

const databaseId = "11111111-2222-4333-8444-555555555555";
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
const input = {
  env,
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
    bindings: [{ name: "APP_ID", type: "plain_text", text: R2_OWNER.app_id }],
  },
};

function harness(options = {}) {
  const events = [];
  const writes = [];
  let lookupCount = 0;
  let migrated = false;
  const response = (result) => Response.json({ success: true, result });
  return {
    events,
    writes,
    dependencies: {
      async fetch(url, init) {
        const path = new URL(url).pathname;
        assert.equal(new URL(url).origin, "https://api.cloudflare.com");
        assert.equal(init.redirect, "error");
        const body = init.body ? JSON.parse(init.body) : undefined;
        events.push({ path, method: init.method, sql: body?.sql });
        if (path.includes("/d1/")) {
          if (init.method === "GET") {
            lookupCount++;
            return response(
              options.absentD1 ? [] : [{ name: D1_NAME, uuid: databaseId }],
            );
          }
          if (!body?.sql) {
            writes.push("create-d1");
            return response({ name: D1_NAME, uuid: databaseId });
          }
          assert.match(body.sql, /^SELECT /);
          let rows;
          if (body.sql.includes("sqlite_schema"))
            rows =
              options.invalidD1 || (options.changedD1 && lookupCount > 1)
                ? []
                : [{ name: "project_metadata" }];
          else if (body.sql.includes("FROM project_metadata"))
            rows = [D1_MARKER];
          else if (body.sql.includes("FROM d1_migrations"))
            rows = (migrated ? migrations : migrations.slice(0, 1)).map(
              (name) => ({ name }),
            );
          else assert.fail("Unexpected SQL");
          return response([{ success: true, results: rows }]);
        }
        assert.ok(path.includes("/r2/") || path.endsWith("/settings"));
        if (options.r2Failure)
          throw new Error("Simulated R2 transport failure");
        assert.equal(
          init.method,
          "GET",
          "Existing marked bucket must never be written",
        );
        if (path.endsWith("/settings")) return response(input.workerSettings);
        if (path.endsWith("/buckets"))
          return response({
            buckets: [{ name: R2_BUCKET, jurisdiction: "default" }],
          });
        if (path.endsWith(`/objects/${R2_OWNER_KEY}`))
          return Response.json(options.unmarkedR2 ? {} : R2_OWNER);
        if (path.endsWith("/domains/managed"))
          return response({ enabled: options.publicR2 ?? false });
        if (path.endsWith("/domains/custom")) return response({ domains: [] });
        assert.fail("Unexpected R2 path");
      },
      async writeConfig(config) {
        writes.push("write-config");
        assert.deepEqual(config.r2_buckets, input.config.r2_buckets);
      },
      async runWrangler(args) {
        writes.push("migrate-d1");
        assert.equal(args[0], "d1");
        migrated = true;
      },
    },
  };
}

test("D1 ownership is verified before R2, and D1 is reinspected before migration", async () => {
  const h = harness();
  const result = await provisionStorage(input, h.dependencies);
  assert.equal(result.databaseId, databaseId);
  assert.deepEqual(h.writes, ["write-config", "migrate-d1"]);
  const firstR2 = h.events.findIndex((event) => event.path.includes("/r2/"));
  const firstLedger = h.events.findIndex((event) =>
    event.sql?.includes("d1_migrations"),
  );
  const lookups = h.events
    .map((event, index) =>
      event.method === "GET" && event.path.endsWith("/d1/database")
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  assert.ok(firstLedger < firstR2);
  assert.equal(lookups.length, 2);
  assert.ok(lookups[1] > firstR2);
});

test("a missing D1 is created only after existing R2 ownership and privacy pass", async () => {
  const h = harness({ absentD1: true });
  const result = await provisionStorage(input, h.dependencies);
  assert.equal(result.databaseId, databaseId);
  assert.deepEqual(h.writes, ["create-d1", "write-config", "migrate-d1"]);
  const privacy = h.events.findIndex((event) =>
    event.path.endsWith("/domains/custom"),
  );
  const creation = h.events.findIndex(
    (event) => event.method === "POST" && event.path.endsWith("/d1/database"),
  );
  assert.ok(privacy >= 0 && creation > privacy);
});

test("invalid existing D1 prevents all R2 requests and writes", async () => {
  const h = harness({ invalidD1: true });
  await assert.rejects(
    provisionStorage(input, h.dependencies),
    /ownership marker/,
  );
  assert.ok(h.events.every((event) => event.path.includes("/d1/")));
  assert.deepEqual(h.writes, []);
});

for (const absentD1 of [false, true]) {
  for (const failure of ["r2Failure", "unmarkedR2", "publicR2"]) {
    test(`${failure} prevents D1 mutation with ${absentD1 ? "absent" : "existing"} database`, async () => {
      const h = harness({ absentD1, [failure]: true });
      await assert.rejects(provisionStorage(input, h.dependencies));
      assert.deepEqual(h.writes, []);
      assert.equal(
        h.events.filter(
          (event) =>
            event.method === "GET" && event.path.endsWith("/d1/database"),
        ).length,
        1,
      );
    });
  }
}

test("D1 ownership changing after R2 inspection prevents D1 mutation", async () => {
  const h = harness({ changedD1: true });
  await assert.rejects(
    provisionStorage(input, h.dependencies),
    /ownership marker/,
  );
  assert.ok(h.events.some((event) => event.path.endsWith("/domains/custom")));
  assert.deepEqual(h.writes, []);
});

test("invalid R2 source config stops before resource inspection", async () => {
  const h = harness();
  await assert.rejects(
    provisionStorage(
      { ...input, config: { ...input.config, r2_buckets: [] } },
      h.dependencies,
    ),
  );
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.writes, []);
});
