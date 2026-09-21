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
function checkReaderHeaders(response) {
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /script-src 'self'/,
  );
}

async function check() {
  const page = await get("/");
  assert.equal(page.status, 200, "Homepage HTTP status");
  checkReaderHeaders(page);
  const html = await page.text();
  assert.match(html, /Emby Wiki/);
  assert.match(html, /<html[^>]*lang="zh"/);
  assert.match(
    html,
    /<article\b/,
    "Homepage must contain server-rendered article content",
  );
  assert.match(
    html,
    /<h1\b[^>]*>[^<]+/,
    "Homepage must contain its article title",
  );
  assert.match(html, /href="#[^"]+"/, "Article must contain heading links");
  assert.match(
    html,
    /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/cf\.emby\.wiki\/zh\/home"/,
    "Canonical URL remains the test Custom Domain even on workers.dev",
  );
  assert.match(html, /<meta\b[^>]*name="description"[^>]*content="[^"]+"/);
  assert.match(html, /<meta\b[^>]*property="og:title"[^>]*content="[^"]+"/);
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
  const english = await get("/en/home");
  assert.equal(english.status, 200, "English article HTTP status");
  checkReaderHeaders(english);
  const englishHtml = await english.text();
  assert.match(englishHtml, /<html[^>]*lang="en"/);
  assert.match(englishHtml, /<article\b/);

  for (const language of ["zh", "en"]) {
    const search = await get(`/api/public/search?lang=${language}&q=Markdown`);
    assert.equal(search.status, 200, `${language} search HTTP status`);
    assert.match(search.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(search.headers.get("cache-control"), "no-store");
    const payload = await search.json();
    assert.ok(payload.results.length > 0, `${language} search returns results`);
    for (const result of payload.results) {
      assert.ok(
        result.path.startsWith(`/${language}/`),
        "Search isolates locale",
      );
      assert.equal(typeof result.title, "string");
      assert.equal(typeof result.excerpt, "string");
    }
  }

  const chineseSearch = await get(
    `/api/public/search?lang=zh&q=${encodeURIComponent("阅读指南")}`,
  );
  assert.equal(chineseSearch.status, 200, "Chinese phrase search HTTP status");
  const chineseResults = (await chineseSearch.json()).results;
  assert.ok(
    chineseResults.some((result) => result.path === "/zh/guide/reading"),
    "Chinese phrase search finds the published reading guide",
  );

  const searchPage = await get("/zh/search?q=Markdown");
  assert.equal(searchPage.status, 200, "Search page HTTP status");
  checkReaderHeaders(searchPage);
  assert.match(await searchPage.text(), /href="\/zh\/guide\/markdown"/);

  for (const path of ["/zh/missing", "/fr/home"]) {
    const notFound = await get(path, {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    assert.equal(notFound.status, 404, `${path} must return real HTTP 404`);
    checkReaderHeaders(notFound);
  }

  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200, "Sitemap HTTP status");
  assert.match(sitemap.headers.get("content-type") ?? "", /xml/);
  assert.match(sitemap.headers.get("x-robots-tag") ?? "", /noindex/);
  const sitemapXml = await sitemap.text();
  assert.match(sitemapXml, /<loc>https:\/\/cf\.emby\.wiki\/zh\/home<\/loc>/);
  assert.match(sitemapXml, /<loc>https:\/\/cf\.emby\.wiki\/en\/home<\/loc>/);
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
    `Smoke passed: ${base} SSR articles and search zh/en; metadata and sitemap; assets 200; health 200; revision ${expectedRevision}; API and reader 404; noindex.`,
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
