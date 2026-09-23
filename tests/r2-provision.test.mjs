import assert from "node:assert/strict";
import { test } from "node:test";
import { R2_BUCKET, R2_OWNER, R2_OWNER_KEY } from "../scripts/r2-policy.mjs";
import {
  ensureR2,
  validateR2Config,
  verifyWorkerR2Binding,
} from "../scripts/r2-provision.mjs";

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
const binding = { binding: "MEDIA", bucket_name: R2_BUCKET, remote: false };
const config = { name: "cloudflare-wiki", r2_buckets: [binding] };
const owner = { name: "APP_ID", type: "plain_text", text: R2_OWNER.app_id };
const media = { name: "MEDIA", type: "r2_bucket", bucket_name: R2_BUCKET };
const input = { env, config, workerSettings: { bindings: [owner] } };
const target = {
  name: R2_BUCKET,
  jurisdiction: "default",
  storage_class: "Standard",
};
const bucketPath = `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`;
const markerPath = `${bucketPath}/${R2_BUCKET}/objects/${R2_OWNER_KEY}`;
const managedPath = `${bucketPath}/${R2_BUCKET}/domains/managed`;
const customPath = `${bucketPath}/${R2_BUCKET}/domains/custom`;
const canary = "upstream-body-must-not-be-logged";
const markerText = JSON.stringify(R2_OWNER);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const envelope = (result) => ({ success: true, result });

function harness(options = {}) {
  const calls = [];
  let present = options.existing ?? false;
  let markerWritten = present;
  const dependencies = {
    async fetch(urlValue, init) {
      const url = new URL(urlValue);
      const call = { url, method: init.method, body: init.body };
      calls.push(call);
      assert.equal(url.origin, "https://api.cloudflare.com");
      assert.equal(init.redirect, "error");
      assert.equal(
        init.headers.Authorization,
        `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      );
      assert.equal(init.headers["cf-r2-jurisdiction"], "default");
      assert.ok(init.signal instanceof AbortSignal);
      assert.ok(
        [bucketPath, markerPath, managedPath, customPath].includes(
          url.pathname,
        ),
      );
      const override = await options.onRequest?.(call);
      if (override !== undefined) return override;
      if (url.pathname === bucketPath && init.method === "GET") {
        assert.equal(init.body, undefined);
        return json(
          options.inventory ??
            envelope({ buckets: present ? [options.target ?? target] : [] }),
        );
      }
      if (url.pathname === bucketPath && init.method === "POST") {
        assert.equal(present, false, "No adoption or duplicate creation");
        assert.equal(init.headers["Content-Type"], "application/json");
        assert.deepEqual(JSON.parse(init.body), {
          name: R2_BUCKET,
          storageClass: "Standard",
        });
        present = true;
        return json(envelope(options.creation ?? target));
      }
      if (url.pathname === markerPath && init.method === "PUT") {
        assert.equal(present, true);
        assert.equal(markerWritten, false, "Never overwrite a marker");
        assert.equal(
          init.body,
          markerText,
          "Upload raw JSON, not multipart or an API envelope",
        );
        markerWritten = true;
        return json(
          envelope(
            options.upload ?? {
              key: R2_OWNER_KEY,
              size: String(Buffer.byteLength(markerText)),
            },
          ),
        );
      }
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(present, true);
      if (url.pathname === markerPath) {
        assert.equal(
          markerWritten,
          true,
          "Readback follows the confirmed upload",
        );
        return json(options.marker === undefined ? R2_OWNER : options.marker);
      }
      if (url.pathname === managedPath)
        return json(envelope(options.managed ?? { enabled: false }));
      if (url.pathname === customPath)
        return json(envelope(options.custom ?? { domains: [] }));
      assert.fail("Unexpected request");
    },
  };
  return {
    calls,
    dependencies,
    writes: () => calls.filter((call) => call.method !== "GET"),
  };
}

async function rejected(h, values = input, pattern = /R2 provisioning:/) {
  await assert.rejects(ensureR2(values, h.dependencies), (error) => {
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(canary));
    assert.ok(!error.message.includes(env.CLOUDFLARE_API_TOKEN));
    if (h.writes().length) {
      assert.match(error.message, /may be incomplete/);
      assert.doesNotMatch(error.message, /No .*changes were made/);
    }
    return true;
  });
}

test("creates one fixed bucket and marker, then verifies ownership and privacy", async () => {
  const h = harness();
  assert.deepEqual(await ensureR2(input, h.dependencies), {
    bucketName: R2_BUCKET,
    created: true,
  });
  assert.deepEqual(
    h.calls.map(({ method, url }) => [method, url.pathname]),
    [
      ["GET", bucketPath],
      ["POST", bucketPath],
      ["PUT", markerPath],
      ["GET", markerPath],
      ["GET", managedPath],
      ["GET", customPath],
    ],
  );
});

test("owned existing bucket is reused with reads only and optional MEDIA", async () => {
  for (const bindings of [[owner], [owner, media]]) {
    const h = harness({ existing: true });
    assert.deepEqual(
      await ensureR2(
        { ...input, workerSettings: { bindings } },
        h.dependencies,
      ),
      { bucketName: R2_BUCKET, created: false },
    );
    assert.equal(h.writes().length, 0);
    assert.equal(h.calls.length, 4);
  }
});

test("manual main and an absent Worker remain valid guarded initialization", async () => {
  const h = harness();
  await ensureR2(
    {
      ...input,
      workerSettings: null,
      env: { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" },
    },
    h.dependencies,
  );
  assert.equal(h.writes().length, 2);
});

test("omitted default jurisdiction and storage class are accepted", async () => {
  const h = harness({ creation: { name: R2_BUCKET } });
  await ensureR2(input, h.dependencies);
  const existing = harness({ existing: true, target: { name: R2_BUCKET } });
  await ensureR2(input, existing.dependencies);
  assert.equal(existing.writes().length, 0);
});

for (const [key, value] of Object.entries({
  GITHUB_ACTIONS: "false",
  GITHUB_REPOSITORY: "other/repo",
  GITHUB_REF: "refs/heads/feature/r2-storage",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_SHA: "main",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "../other",
  CLOUDFLARE_ZONE_ID: "invalid",
  CLOUDFLARE_WORKER_NAME: "other",
  TEST_DOMAIN: "emby.wiki",
})) {
  test(`rejects unsafe Actions environment ${key} before requests`, async () => {
    const h = harness();
    await rejected(h, { ...input, env: { ...env, [key]: value } });
    assert.equal(h.calls.length, 0);
  });
}

for (const [label, changed] of [
  ["missing", undefined],
  ["empty", []],
  ["duplicate", [binding, binding]],
  ["wrong name", [{ ...binding, binding: "OTHER" }]],
  ["wrong bucket", [{ ...binding, bucket_name: "other" }]],
  ["remote", [{ ...binding, remote: true }]],
  ["missing remote", [{ ...binding, remote: undefined }]],
  ["preview", [{ ...binding, preview_bucket_name: R2_BUCKET }]],
  ["jurisdiction", [{ ...binding, jurisdiction: "eu" }]],
  ["null jurisdiction", [{ ...binding, jurisdiction: null }]],
  ["unknown field", [{ ...binding, local_dev: {} }]],
]) {
  test(`rejects ${label} source binding before requests`, async () => {
    const h = harness();
    await rejected(h, { ...input, config: { ...config, r2_buckets: changed } });
    assert.equal(h.calls.length, 0);
  });
}

test("config allows only fixed Worker and explicit default jurisdiction", () => {
  assert.doesNotThrow(() => validateR2Config(config));
  assert.doesNotThrow(() =>
    validateR2Config({
      ...config,
      r2_buckets: [{ ...binding, jurisdiction: "default" }],
    }),
  );
  assert.throws(() => validateR2Config({ ...config, name: "other" }));
});

for (const bindings of [
  [owner, { ...media, bucket_name: "other" }],
  [owner, { ...media, jurisdiction: "eu" }],
  [owner, { ...media, type: "kv_namespace" }],
  [owner, media, media],
  [owner, { ...media, name: "OTHER" }],
]) {
  test(`rejects conflicting existing binding ${JSON.stringify(bindings.at(-1))}`, async () => {
    const h = harness({ existing: true });
    await rejected(
      h,
      { ...input, workerSettings: { bindings } },
      /MEDIA binding/,
    );
    assert.equal(h.writes().length, 0);
    assert.equal(h.calls.length, 1);
  });
}

test("an absent bucket cannot replace an existing MEDIA binding", async () => {
  const h = harness();
  await rejected(
    h,
    { ...input, workerSettings: { bindings: [owner, media] } },
    /MEDIA binding/,
  );
  assert.equal(h.writes().length, 0);
});

test("strict postdeployment binding readback rejects missing and malformed settings", () => {
  assert.equal(verifyWorkerR2Binding({ bindings: [media] }), true);
  assert.equal(
    verifyWorkerR2Binding({ bindings: [] }, { allowAbsent: true }),
    false,
  );
  for (const settings of [
    null,
    {},
    { bindings: [] },
    { bindings: [null] },
    { bindings: [media, media] },
    { bindings: [{ ...media, jurisdiction: null }] },
  ])
    assert.throws(() => verifyWorkerR2Binding(settings));
});

for (const workerSettings of [
  { bindings: [] },
  { bindings: [{ ...owner, text: canary }] },
  { bindings: [owner, owner] },
  { bindings: [{ ...owner, type: "secret_text" }] },
  { bindings: [null] },
]) {
  test(`rejects unowned or malformed Worker ${JSON.stringify(workerSettings)}`, async () => {
    const h = harness();
    await rejected(h, { ...input, workerSettings });
    assert.equal(h.calls.length, 0);
  });
}

for (const [label, options] of [
  ["unmarked", { marker: {} }],
  ["foreign marker", { marker: { ...R2_OWNER, app_id: canary } }],
  ["public managed domain", { managed: { enabled: true } }],
  [
    "custom domain",
    { custom: { domains: [{ domain: canary, enabled: false }] } },
  ],
  ["wrong jurisdiction", { target: { ...target, jurisdiction: "eu" } }],
  [
    "nonstandard storage",
    { target: { ...target, storage_class: "InfrequentAccess" } },
  ],
]) {
  test(`does not alter an existing ${label} bucket`, async () => {
    const h = harness({ existing: true, ...options });
    await rejected(h);
    assert.equal(h.writes().length, 0);
  });
}

test("ambiguous inventory never reaches creation", async () => {
  const h = harness({ inventory: envelope({ buckets: [target, target] }) });
  await rejected(h, input, /duplicate/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.writes().length, 0);
});

for (const method of ["POST", "PUT"]) {
  for (const status of [301, 400, 401, 403, 409, 429, 500]) {
    test(`${method} HTTP ${status} stops without retry or following writes`, async () => {
      const h = harness({
        onRequest: (call) =>
          call.method === method ? new Response(canary, { status }) : undefined,
      });
      await rejected(h, input, new RegExp(`HTTP ${status}`));
      assert.equal(h.calls.at(-1).method, method);
      assert.equal(h.writes().length, method === "POST" ? 1 : 2);
    });
  }
  for (const [label, response] of [
    [
      "transport rejection",
      () => {
        throw new Error(canary);
      },
    ],
    ["invalid JSON", () => new Response(canary)],
    [
      "unsuccessful envelope",
      () => json({ success: false, errors: [{ message: canary }] }),
    ],
    ["empty success envelope", () => json(envelope({}))],
    ["oversized response", () => new Response(" ".repeat(256 * 1024 + 1))],
  ]) {
    test(`${method} ${label} leaves outcome explicit and stops`, async () => {
      const h = harness({
        onRequest: (call) => (call.method === method ? response() : undefined),
      });
      await rejected(h);
      assert.equal(h.calls.at(-1).method, method);
      assert.equal(h.writes().length, method === "POST" ? 1 : 2);
    });
  }
}

for (const creation of [
  { ...target, name: "other" },
  { ...target, jurisdiction: "eu" },
  { ...target, jurisdiction: null },
  { ...target, storage_class: "InfrequentAccess" },
]) {
  test(`invalid creation identity prevents marker upload ${JSON.stringify(creation)}`, async () => {
    const h = harness({ creation });
    await rejected(h);
    assert.equal(h.writes().length, 1);
    assert.equal(h.calls.at(-1).method, "POST");
  });
}

for (const upload of [
  { key: "other", size: String(Buffer.byteLength(markerText)) },
  { key: R2_OWNER_KEY, size: 1 },
  { key: R2_OWNER_KEY, size: "1" },
  { key: R2_OWNER_KEY, size: `0${Buffer.byteLength(markerText)}` },
]) {
  test(`invalid upload metadata stops before successful readback ${JSON.stringify(upload)}`, async () => {
    const h = harness({ upload });
    await rejected(h, input, /metadata/);
    assert.equal(h.writes().length, 2);
    assert.equal(h.calls.at(-1).method, "PUT");
  });
}

for (const [label, options] of [
  ["wrong marker", { marker: {} }],
  ["public state", { managed: { enabled: true } }],
  ["domain attachment", { custom: { domains: [{}] } }],
]) {
  test(`new bucket ${label} readback fails without cleanup or repair`, async () => {
    const h = harness(options);
    await rejected(h);
    assert.equal(h.writes().length, 2);
    assert.equal(h.calls.at(-1).method, "GET");
  });
}

test("a later run never marks a bucket left unmarked by an uncertain creation", async () => {
  const uncertain = harness({
    onRequest: (call) => {
      if (call.method === "POST") throw new Error(canary);
    },
  });
  await rejected(uncertain, input, /outcome may be unknown/);
  const later = harness({
    existing: true,
    onRequest: (call) =>
      call.url.pathname === markerPath
        ? new Response(canary, { status: 404 })
        : undefined,
  });
  await rejected(later, input, /HTTP 404/);
  assert.equal(later.writes().length, 0);
});
