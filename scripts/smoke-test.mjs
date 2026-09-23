import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
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
function checkSecurityHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /script-src 'self'/,
  );
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /(?:^|;)\s*style-src 'self'(?:;|$)/,
  );
  assert.ok(
    !/'unsafe-(?:inline|eval)'/.test(
      response.headers.get("content-security-policy") ?? "",
    ),
    "Anonymous responses must retain strict script and style policies",
  );
}
function checkReaderHeaders(response) {
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  checkSecurityHeaders(response);
}

function inertData(html, id) {
  const match = new RegExp(
    `<script id="${id}" type="application/json">([\\s\\S]*?)</script>`,
  ).exec(html);
  assert.ok(match, "Document must include its inert hydration data");
  return JSON.parse(match[1]);
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function checkTitle(html, expected) {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const decoded = title?.replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (_, entity) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[
        entity
      ],
  );
  assert.ok(
    decoded === expected,
    "Document title must use its localized site name",
  );
}

function checkSettings(settings, html) {
  assert.deepEqual(Object.keys(settings).sort(), [
    "accent",
    "defaultLanguage",
    "locales",
    "logo",
    "theme",
  ]);
  assert.ok(["zh", "en"].includes(settings.defaultLanguage));
  assert.ok(["system", "light", "dark"].includes(settings.theme));
  assert.ok(["forest", "ocean", "plum"].includes(settings.accent));
  assert.ok(["emby", "book", "none"].includes(settings.logo));
  assert.deepEqual(Object.keys(settings.locales).sort(), ["en", "zh"]);
  for (const identity of Object.values(settings.locales)) {
    assert.deepEqual(Object.keys(identity).sort(), ["description", "name"]);
    assert.equal(typeof identity.name, "string");
    assert.ok(identity.name.length > 0 && identity.name.length <= 80);
    assert.equal(typeof identity.description, "string");
    assert.ok(identity.description.length <= 300);
  }
  const documentTag = /<html\b[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(documentTag.includes(`data-theme="${settings.theme}"`));
  assert.ok(documentTag.includes(`data-accent="${settings.accent}"`));
  assert.ok(
    html.includes('<script src="/assets/site-appearance.js"></script>'),
  );
}

export async function checkHome(response, explicitLanguage) {
  assert.equal(response.status, 200, "Homepage HTTP status");
  checkReaderHeaders(response);
  const html = await response.text();
  const data = inertData(html, "reader-data");
  checkSettings(data.settings, html);
  const language = explicitLanguage ?? data.settings.defaultLanguage;
  assert.ok(["zh", "en"].includes(language));
  assert.equal(
    data.language,
    language,
    "Homepage follows its selected language",
  );
  assert.equal(data.page?.language, language);
  assert.equal(data.page?.path, "home");
  assert.equal(data.mode, "article");
  assert.match(html, new RegExp(`<html\\b[^>]*\\blang="${language}"`));
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
  assert.ok(
    html.includes(
      `<link rel="canonical" href="https://cf.emby.wiki/${language}/home">`,
    ),
    "Canonical URL remains the selected language on the test Custom Domain",
  );
  const identity = data.settings.locales[language];
  checkTitle(html, `${data.page.title} · ${identity.name}`);
  assert.ok(
    html.includes(
      `<meta property="og:site_name" content="${escapeHtml(identity.name)}">`,
    ),
  );
  assert.ok(
    html.includes(
      `<meta property="og:title" content="${escapeHtml(`${data.page.title} · ${identity.name}`)}">`,
    ),
  );
  assert.ok(
    html.includes(
      `<meta name="description" content="${escapeHtml(data.page.description || identity.description)}">`,
    ),
  );
  assert.ok(
    html.includes(
      '<link rel="alternate" hreflang="zh" href="https://cf.emby.wiki/zh/home">',
    ),
  );
  assert.ok(
    html.includes(
      '<link rel="alternate" hreflang="en" href="https://cf.emby.wiki/en/home">',
    ),
  );
  return html;
}

// Anonymous GETs only: deployment smoke must never initialize an account,
// consume a setup token, create a session or change authentication state.
export async function checkAdmin(getResponse) {
  const page = await getResponse("/admin");
  assert.equal(page.status, 200, "Administrator shell HTTP status");
  checkReaderHeaders(page);
  const html = await page.text();
  const settings = inertData(html, "site-settings");
  checkSettings(settings, html);
  checkTitle(
    html,
    `Administration · ${settings.locales[settings.defaultLanguage].name}`,
  );
  assert.ok(/<div\b[^>]*id="root"/.test(html), "Administrator mount point");
  assert.ok(
    /src="\/assets\/(?!site-appearance\.js)[^"]+\.js"/.test(html),
    "Administrator entry asset",
  );

  for (const path of [
    "/api/admin/session",
    "/api/admin/overview",
    "/api/admin/pages",
    "/api/admin/pages/starter-home-en",
    "/api/admin/pages/starter-home-en/revisions",
    "/api/admin/pages/starter-home-en/events",
    "/api/admin/navigation/zh",
    "/api/admin/redirects/zh",
    "/api/admin/redirects/en",
    "/api/admin/settings",
    "/api/admin/audit",
    "/api/admin/files",
    "/api/admin/files/00000000-0000-4000-8000-000000000000/download",
  ]) {
    const response = await getResponse(path);
    assert.equal(response.status, 401, `${path} rejects anonymous access`);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/,
    );
    checkSecurityHeaders(response);
    const body = await response.json();
    // Assertion output must not echo an unexpectedly leaked account payload.
    assert.ok(
      body &&
        Object.keys(body).length === 1 &&
        body.error === "Sign in required",
      "Anonymous administrator response must contain only the sign-in error",
    );
  }

  for (const path of [
    "/admin/pages/new",
    "/admin/pages/starter-home-en/history",
  ]) {
    const response = await getResponse(path, { redirect: "manual" });
    assert.equal(
      response.status,
      303,
      "Anonymous editor documents require sign-in",
    );
    checkSecurityHeaders(response);
    assert.ok(
      response.headers.get("Location") ===
        `/admin?returnTo=${encodeURIComponent(path)}`,
      "Editor login redirect must preserve only the requested internal document",
    );
    assert.ok(
      response.headers.get("Set-Cookie") === null,
      "Anonymous editor redirect must not issue a session",
    );
    assert.ok(
      (await response.text()).length === 0,
      "Anonymous editor redirect must not include document data",
    );
  }

  const setup = await getResponse("/api/admin/setup");
  assert.equal(setup.status, 200, "Setup status HTTP status");
  assert.match(setup.headers.get("content-type") ?? "", /application\/json/);
  checkSecurityHeaders(setup);
  assert.ok(
    setup.headers.get("set-cookie") === null,
    "Setup status must not issue a cookie",
  );
  const status = await setup.json();
  assert.deepEqual(Object.keys(status).sort(), [
    "initialized",
    "setupAvailable",
  ]);
  assert.equal(typeof status.initialized, "boolean");
  assert.equal(typeof status.setupAvailable, "boolean");
  assert.ok(!status.initialized || !status.setupAvailable);
}

async function check() {
  const page = await get("/");
  const html = await checkHome(page);
  for (const language of ["zh", "en"])
    await checkHome(await get(`/${language}/home`), language);
  const script = html.match(
    /src="(\/assets\/(?!site-appearance\.js)[^"]+\.js)"/,
  );
  assert.ok(script, "Homepage must load a built JavaScript asset");
  const asset = await get(script[1]);
  assert.equal(asset.status, 200, "JavaScript asset HTTP status");
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  const appearance = await get("/assets/site-appearance.js");
  assert.equal(
    appearance.status,
    200,
    "First-paint appearance asset HTTP status",
  );
  assert.match(appearance.headers.get("content-type") ?? "", /javascript/);
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
  await checkAdmin(get);
  for (const representation of ["download", "image", "thumbnail"]) {
    const missingFile = await get(
      `/files/00000000-0000-4000-8000-000000000000/${representation}`,
    );
    assert.equal(missingFile.status, 404, "Unknown public file is unavailable");
    checkSecurityHeaders(missingFile);
    assert.deepEqual(await missingFile.json(), { error: "File not found." });
  }
  if (url.protocol === "https:") {
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /default-src 'self'/,
    );
  }
  console.log(
    `Smoke passed: ${base} configured homepage and explicit articles/search zh/en; localized metadata and sitemap; assets 200; health 200; revision ${expectedRevision}; API, reader and file 404; admin shell; anonymous content/revision/event/navigation/redirect/settings/audit/file APIs 401 and editor documents 303; strict anonymous CSP; noindex.`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
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
}
