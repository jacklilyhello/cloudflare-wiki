import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { validateSmokeBaseUrl } from "./smoke-policy.mjs";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4173";
const url = validateSmokeBaseUrl(base, process.env.SMOKE_WORKERS_DEV_SUBDOMAIN);
const expectedRevision = process.env.EXPECTED_SHA ?? "local";
async function get(path, options) {
  return fetch(new URL(path, base), {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
}
async function check() {
  const page = await get("/");
  assert.equal(page.status, 200, "Homepage HTTP status");
  const html = await page.text();
  assert.match(html, /Cloudflare Wiki/);
  const script = html.match(/src="(\/assets\/[^"]+\.js)"/);
  assert.ok(script, "Homepage must load a built JavaScript asset");
  const asset = await get(script[1]);
  assert.equal(asset.status, 200, "JavaScript asset HTTP status");
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  const health = await get("/health", {
    headers: { "Sec-Fetch-Mode": "navigate" },
  });
  assert.equal(health.status, 200, "Health HTTP status");
  assert.match(health.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "cloudflare-wiki",
    environment: "test",
    revision: expectedRevision,
  });
  const missing = await get("/api/not-implemented", {
    headers: { "Sec-Fetch-Mode": "navigate" },
  });
  assert.equal(missing.status, 404, "API must not fall back to SPA HTML");
  assert.deepEqual(await missing.json(), { error: "Not found" });
  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \//);
  if (url.protocol === "https:") {
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
  }
  console.log(
    `Smoke passed: ${base} HTTP 200; assets 200; health 200; revision ${expectedRevision}; API 404; noindex.`,
  );
}
let failure;
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    await check();
    failure = undefined;
    break;
  } catch (error) {
    failure = error;
    console.log(`Smoke attempt ${attempt}/12 failed: ${error.message}`);
    if (attempt < 12) await setTimeout(10_000);
  }
}
if (failure) throw failure;
