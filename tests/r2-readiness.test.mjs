import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { test } from "node:test";
import {
  checkR2Readiness,
  R2_BUCKET,
  R2_OWNER,
  R2_OWNER_KEY,
} from "../scripts/r2-readiness.mjs";

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: "a".repeat(40),
  CLOUDFLARE_API_TOKEN: "test-only-placeholder",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  CLOUDFLARE_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
  TEST_DOMAIN: "cf.emby.wiki",
};
const prefix = `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
const inventoryPath = `${prefix}/r2/buckets`;
const workerPath = `${prefix}/workers/scripts/cloudflare-wiki/settings`;
const markerPath = `${inventoryPath}/${R2_BUCKET}/objects/${R2_OWNER_KEY}`;
const managedPath = `${inventoryPath}/${R2_BUCKET}/domains/managed`;
const customPath = `${inventoryPath}/${R2_BUCKET}/domains/custom`;
const target = { name: R2_BUCKET, jurisdiction: "default" };
const owner = { name: "APP_ID", type: "plain_text", text: R2_OWNER.app_id };
const media = {
  name: "MEDIA",
  type: "r2_bucket",
  bucket_name: R2_BUCKET,
  jurisdiction: "default",
};
const absent =
  "R2 inventory readable; target bucket absent; write permission unverified";
const existing =
  "R2 inventory readable; target bucket ownership and private access verified; write permission unverified";
const canary = "upstream-private-body-not-for-logs";
const json = (body, options) => new Response(JSON.stringify(body), options);
const envelope = (result, extra = {}) => ({ success: true, result, ...extra });

function harness(options = {}) {
  const calls = [];
  let page = 0;
  const dependencies = {
    async fetch(input, init) {
      const url = new URL(input);
      const path = url.pathname;
      calls.push({ url, init });
      assert.equal(url.origin, "https://api.cloudflare.com");
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(
        init.headers.Authorization,
        `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      );
      assert.ok(
        [
          inventoryPath,
          workerPath,
          markerPath,
          managedPath,
          customPath,
        ].includes(path),
      );
      assert.equal(
        init.headers["cf-r2-jurisdiction"],
        path.includes("/r2/") ? "default" : undefined,
      );
      const override = await options.onRequest?.(path, calls.length);
      if (override !== undefined) return override;
      if (path === inventoryPath) {
        assert.equal(url.searchParams.get("name_contains"), R2_BUCKET);
        assert.equal(url.searchParams.get("per_page"), "100");
        const pages = options.pages ?? [envelope({ buckets: [target] })];
        assert.ok(page < pages.length, "No extra inventory requests");
        return json(pages[page++]);
      }
      assert.equal(url.search, "");
      if (path === workerPath)
        return json(envelope(options.worker ?? { bindings: [owner] }));
      if (path === markerPath)
        return json(options.marker === undefined ? R2_OWNER : options.marker);
      if (path === managedPath)
        return json(
          envelope(
            options.managed === undefined
              ? { bucketId: "test", domain: "test.r2.dev", enabled: false }
              : options.managed,
          ),
        );
      if (path === customPath)
        return json(
          envelope(
            options.custom === undefined ? { domains: [] } : options.custom,
          ),
        );
      assert.fail("Unexpected endpoint");
    },
  };
  return { calls, dependencies };
}

async function rejectsSanitized(h, pattern = /R2 readiness:/, settings = env) {
  await assert.rejects(checkR2Readiness(settings, h.dependencies), (error) => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(
      error.message,
      new RegExp(`${canary}|${env.CLOUDFLARE_API_TOKEN}`),
    );
    return true;
  });
}

test("conclusive absence is a read-only observation, not write readiness", async () => {
  const h = harness({ pages: [envelope({ buckets: [] })] });
  assert.equal(await checkR2Readiness(env, h.dependencies), absent);
  assert.deepEqual(
    h.calls.map(({ url }) => url.pathname),
    [inventoryPath, workerPath],
  );
});

test("exact marked private bucket accepts an absent or matching MEDIA binding", async () => {
  for (const bindings of [[owner], [owner, media]]) {
    const h = harness({ worker: { bindings } });
    assert.equal(await checkR2Readiness(env, h.dependencies), existing);
    assert.deepEqual(
      h.calls.map(({ url }) => url.pathname),
      [inventoryPath, workerPath, markerPath, managedPath, customPath],
    );
  }
});

test("follows full-envelope cursors even after short pages, then matches exact name", async () => {
  const h = harness({
    pages: [
      envelope(
        { buckets: [{ name: `${R2_BUCKET}-other` }] },
        { result_info: { cursor: "opaque+/==?next" } },
      ),
      envelope({ buckets: [target] }, { result_info: { cursor: "" } }),
    ],
  });
  assert.equal(await checkR2Readiness(env, h.dependencies), existing);
  assert.equal(h.calls[1].url.searchParams.get("cursor"), "opaque+/==?next");
  const other = harness({
    pages: [envelope({ buckets: [{ name: `${R2_BUCKET}-other` }] })],
  });
  assert.equal(await checkR2Readiness(env, other.dependencies), absent);
});

test("an omitted jurisdiction represents the default jurisdiction", async () => {
  const h = harness({
    pages: [envelope({ buckets: [{ name: R2_BUCKET }] })],
    worker: { bindings: [owner, { ...media, jurisdiction: undefined }] },
  });
  assert.equal(await checkR2Readiness(env, h.dependencies), existing);
});

for (const [label, change] of [
  ["local", { GITHUB_ACTIONS: "false" }],
  ["other repository", { GITHUB_REPOSITORY: "other/wiki" }],
  ["feature branch", { GITHUB_REF: "refs/heads/chore/r2-readiness" }],
  ["push", { GITHUB_EVENT_NAME: "push" }],
  ["pull request", { GITHUB_EVENT_NAME: "pull_request" }],
  ["missing token", { CLOUDFLARE_API_TOKEN: "" }],
  ["invalid account", { CLOUDFLARE_ACCOUNT_ID: "../other" }],
  ["invalid zone", { CLOUDFLARE_ZONE_ID: "" }],
  ["invalid SHA", { GITHUB_SHA: "main" }],
  ["other Worker", { CLOUDFLARE_WORKER_NAME: "other" }],
  ["production domain", { TEST_DOMAIN: "emby.wiki" }],
]) {
  test(`rejects ${label} before any request`, async () => {
    const h = harness();
    await rejectsSanitized(h, /R2 readiness:/, { ...env, ...change });
    assert.equal(h.calls.length, 0);
  });
}

for (const [label, pages] of [
  ["non-object envelope", [null]],
  ["missing success", [{ result: { buckets: [] } }]],
  ["unsuccessful envelope", [envelope({ buckets: [] }, { success: false })]],
  [
    "error envelope",
    [envelope({ buckets: [] }, { errors: [{ message: canary }] })],
  ],
  ["malformed errors", [envelope({ buckets: [] }, { errors: {} })]],
  ["missing buckets", [envelope({})]],
  ["malformed bucket", [envelope({ buckets: [null] })]],
  ["invalid bucket name", [envelope({ buckets: [{ name: 7 }] })]],
  ["duplicate bucket", [envelope({ buckets: [target, target] })]],
  ["malformed result info", [envelope({ buckets: [] }, { result_info: [] })]],
  [
    "malformed page size",
    [envelope({ buckets: [] }, { result_info: { per_page: "100" } })],
  ],
  [
    "inconsistent page size",
    [envelope({ buckets: [] }, { result_info: { per_page: 20 } })],
  ],
  [
    "null cursor",
    [envelope({ buckets: [] }, { result_info: { cursor: null } })],
  ],
  [
    "numeric cursor",
    [envelope({ buckets: [] }, { result_info: { cursor: 1 } })],
  ],
  [
    "oversized cursor",
    [envelope({ buckets: [] }, { result_info: { cursor: "x".repeat(4097) } })],
  ],
  [
    "full page without continuation",
    [
      envelope({
        buckets: Array.from({ length: 100 }, (_, index) => ({
          name: `test-bucket-${index}`,
        })),
      }),
    ],
  ],
  [
    "oversized page",
    [
      envelope({
        buckets: Array.from({ length: 101 }, (_, index) => ({
          name: `test-bucket-${index}`,
        })),
      }),
    ],
  ],
  [
    "repeated cursor",
    [
      envelope({ buckets: [] }, { result_info: { cursor: "same" } }),
      envelope({ buckets: [] }, { result_info: { cursor: "same" } }),
    ],
  ],
  [
    "duplicate across pages",
    [
      envelope({ buckets: [target] }, { result_info: { cursor: "next" } }),
      envelope({ buckets: [target] }),
    ],
  ],
]) {
  test(`fails closed on ${label}`, async () => {
    const h = harness({ pages });
    await rejectsSanitized(h);
    assert.ok(h.calls.every(({ url }) => url.pathname === inventoryPath));
  });
}

test("unbounded pagination stops at 25 requests without retry", async () => {
  const h = harness({
    pages: Array.from({ length: 25 }, (_, index) =>
      envelope({ buckets: [] }, { result_info: { cursor: `page-${index}` } }),
    ),
  });
  await rejectsSanitized(h, /pagination limit/);
  assert.equal(h.calls.length, 25);
});

for (const jurisdiction of ["eu", "us", "", null]) {
  test(`rejects target jurisdiction ${JSON.stringify(jurisdiction)}`, async () => {
    const h = harness({
      pages: [envelope({ buckets: [{ ...target, jurisdiction }] })],
    });
    await rejectsSanitized(h, /jurisdiction/);
    assert.equal(h.calls.length, 1);
  });
}

for (const [label, bindings] of [
  ["missing ownership", []],
  ["foreign ownership", [{ ...owner, text: canary }]],
  ["invalid ownership type", [{ ...owner, type: "secret_text" }]],
  ["duplicate ownership", [owner, owner]],
  ["malformed binding", [owner, null]],
  ["wrong target", [owner, { ...media, bucket_name: "other" }]],
  ["wrong jurisdiction", [owner, { ...media, jurisdiction: "eu" }]],
  ["null jurisdiction", [owner, { ...media, jurisdiction: null }]],
  ["wrong MEDIA type", [owner, { ...media, type: "kv_namespace" }]],
  ["unexpected R2 binding", [owner, { ...media, name: "OTHER" }]],
  ["duplicate MEDIA binding", [owner, media, media]],
]) {
  test(`rejects Worker ${label} before object access`, async () => {
    const h = harness({ worker: { bindings } });
    await rejectsSanitized(h);
    assert.equal(h.calls.length, 2);
  });
}

test("absent bucket with existing MEDIA binding is inconsistent", async () => {
  const h = harness({
    pages: [envelope({ buckets: [] })],
    worker: { bindings: [owner, media] },
  });
  await rejectsSanitized(h, /MEDIA binding/);
  assert.equal(h.calls.length, 2);
});

for (const [label, marker] of [
  ["null", null],
  ["array", []],
  ["missing", {}],
  ["extra key", { ...R2_OWNER, extra: true }],
  ["wrong schema", { ...R2_OWNER, schema: "1" }],
  ["wrong owner", { ...R2_OWNER, app_id: canary }],
  ["wrong environment", { ...R2_OWNER, environment: "production" }],
  ["wrong bucket", { ...R2_OWNER, bucket: "other" }],
]) {
  test(`rejects ${label} ownership marker`, async () => {
    const h = harness({ marker });
    await rejectsSanitized(h, /ownership is not verified/);
    assert.equal(h.calls.length, 3);
  });
}

test("marker is bounded to 1 KiB by actual body bytes", async () => {
  const marker = JSON.stringify(R2_OWNER);
  const valid = harness({
    onRequest: (path) =>
      path === markerPath ? new Response(marker.padEnd(1024)) : undefined,
  });
  assert.equal(await checkR2Readiness(env, valid.dependencies), existing);
  const oversized = harness({
    onRequest: (path) =>
      path === markerPath ? new Response(marker.padEnd(1025)) : undefined,
  });
  await rejectsSanitized(oversized, /oversized/);
  assert.equal(oversized.calls.length, 3);
});

for (const [label, response] of [
  ["invalid JSON", () => new Response(canary)],
  ["invalid UTF-8", () => new Response(new Uint8Array([0xc3, 0x28]))],
  [
    "oversized declared length",
    () => new Response("{}", { headers: { "Content-Length": "1025" } }),
  ],
  [
    "malformed declared length",
    () => new Response("{}", { headers: { "Content-Length": "invalid" } }),
  ],
  [
    "stream read failure",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(canary));
          },
        }),
      ),
  ],
]) {
  test(`rejects marker ${label} without response details`, async () => {
    const h = harness({
      onRequest: (path) => (path === markerPath ? response() : undefined),
    });
    await rejectsSanitized(h);
    assert.equal(h.calls.length, 3);
  });
}

for (const managed of [null, {}, { enabled: true }, { enabled: "false" }]) {
  test(`rejects public or unknown managed domain ${JSON.stringify(managed)}`, async () => {
    const h = harness({ managed });
    await rejectsSanitized(h, /managed-domain state/);
    assert.equal(h.calls.length, 4);
  });
}
for (const custom of [
  null,
  {},
  { domains: null },
  { domains: [{ domain: canary, enabled: false }] },
]) {
  test(`rejects custom domains or unknown domain state ${JSON.stringify(custom)}`, async () => {
    const h = harness({ custom });
    await rejectsSanitized(h, /custom domains/);
    assert.equal(h.calls.length, 5);
  });
}

for (const path of [
  inventoryPath,
  workerPath,
  markerPath,
  managedPath,
  customPath,
]) {
  for (const status of [301, 401, 403, 404, 429, 500]) {
    test(`fails closed without retry on HTTP ${status} from ${path.split("/").at(-1)}`, async () => {
      const h = harness({
        onRequest: (requestPath) =>
          requestPath === path
            ? new Response(canary, {
                status,
                headers: { Location: "https://example.com/private" },
              })
            : undefined,
      });
      await rejectsSanitized(h, new RegExp(`HTTP ${status}`));
      assert.equal(
        h.calls.filter(({ url }) => url.pathname === path).length,
        1,
      );
      assert.equal(h.calls.at(-1).url.pathname, path);
    });
  }
}

test("transport exception is sanitized and never retried", async () => {
  const h = harness({
    onRequest() {
      throw new Error(`${canary} ${env.CLOUDFLARE_API_TOKEN}`);
    },
  });
  await rejectsSanitized(h, /no retry/);
  assert.equal(h.calls.length, 1);
});

test("unexpected transport return is sanitized", async () => {
  const h = harness({ onRequest: () => ({ private: canary }) });
  await rejectsSanitized(h, /invalid response/);
});

test("oversized API envelopes are bounded before parsing", async () => {
  const h = harness({
    onRequest: () => new Response(" ".repeat(256 * 1024 + 1)),
  });
  await rejectsSanitized(h, /oversized/);
  assert.equal(h.calls.length, 1);
});

test("CLI refuses local execution without leaking environment or making network requests", () => {
  const result = spawnSync(
    process.execPath,
    [realpathSync(new URL("../scripts/r2-readiness.mjs", import.meta.url))],
    { env: { ...env, GITHUB_ACTIONS: "false" }, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Actions deployment configuration is unauthorized or incomplete/,
  );
  assert.doesNotMatch(result.stderr, new RegExp(env.CLOUDFLARE_API_TOKEN));
});
