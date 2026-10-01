import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { brandSettings, parseBranding } from "../shared/branding.ts";
import { PUBLIC_ORIGIN } from "./deploy-policy.mjs";
import { createSmokeGet, validateSmokeBaseUrl } from "./smoke-policy.mjs";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:4173";
const url = validateSmokeBaseUrl(base);
const get = createSmokeGet(base);
function checkSecurityHeaders(response, indexable = false) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  if (indexable)
    assert.doesNotMatch(
      response.headers.get("x-robots-tag") ?? "",
      /noindex|nofollow/i,
    );
  else assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
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
function checkReaderHeaders(response, indexable = false) {
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  checkSecurityHeaders(response, indexable);
}

function checkIndexableHtml(html) {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/name=["'](?:robots|googlebot|bingbot)["']/i.test(tag[0]))
      assert.doesNotMatch(tag[0], /noindex|nofollow/i);
  }
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

export async function checkLanding(response, explicitLanguage) {
  assert.equal(response.status, 200, "Cover HTTP status");
  assert.equal(
    response.headers.get("Location"),
    null,
    "Root is a document, not a redirect",
  );
  checkReaderHeaders(response, true);
  const html = await response.text();
  checkIndexableHtml(html);
  const data = inertData(html, "reader-data");
  checkSettings(data.settings, html);
  const language = explicitLanguage ?? data.settings.defaultLanguage;
  assert.equal(data.mode, "landing");
  assert.equal(data.language, language);
  assert.equal(data.page, null);
  assert.equal(data.rendered, null);
  assert.deepEqual(data.navigation, []);
  assert.deepEqual(data.searchResults, []);
  assert.deepEqual(data.translations, { zh: "/?lang=zh", en: "/?lang=en" });
  assert.match(html, /<main\b[^>]*id="cover-content"/);
  assert.match(html, /<h1\b[^>]*id="cover-title"/);
  assert.ok(
    !/<article\b/.test(html),
    "Root must not contain Wiki article content",
  );
  assert.ok(
    html.includes(`href="/${language}/home"`),
    "Continue enters the selected reader language",
  );
  for (const locale of ["zh", "en"]) {
    assert.ok(
      html.includes(`href="/?lang=${locale}"`),
      "Both languages work before hydration",
    );
    assert.ok(
      html.includes(
        `<link rel="alternate" hreflang="${locale}" href="${PUBLIC_ORIGIN}/?lang=${locale}">`,
      ),
    );
  }
  assert.ok(html.includes(`<link rel="canonical" href="${PUBLIC_ORIGIN}/">`));
  assert.ok(
    html.includes(
      `<link rel="alternate" hreflang="x-default" href="${PUBLIC_ORIGIN}/">`,
    ),
  );
  assert.ok(
    html.includes(`<meta property="og:url" content="${PUBLIC_ORIGIN}/">`),
  );
  assert.ok(html.includes('<meta property="og:type" content="website">'));
  assert.ok(html.includes('<meta name="theme-color"'));
  const identity = data.settings.locales[language];
  checkTitle(
    html,
    `${identity.name} · ${language === "zh" ? "Emby 技术手册" : "The Emby Handbook"}`,
  );
  assert.ok(
    html.includes(
      `<meta name="description" content="${escapeHtml(identity.description)}">`,
    ),
  );
  return html;
}

export async function checkHome(response, explicitLanguage) {
  assert.equal(response.status, 200, "Homepage HTTP status");
  checkReaderHeaders(response, true);
  const html = await response.text();
  checkIndexableHtml(html);
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
      `<link rel="canonical" href="${PUBLIC_ORIGIN}/${language}/home">`,
    ),
    "Canonical URL remains the selected language on the production origin",
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
      `<link rel="alternate" hreflang="zh" href="${PUBLIC_ORIGIN}/zh/home">`,
    ),
  );
  assert.ok(
    html.includes(
      `<link rel="alternate" hreflang="en" href="${PUBLIC_ORIGIN}/en/home">`,
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
  const branding = parseBranding(
    JSON.stringify(inertData(html, "deployment-branding")),
  );
  const displayed = brandSettings(settings, branding);
  checkSettings(settings, html);
  checkTitle(
    html,
    `Administration · ${displayed.locales[settings.defaultLanguage].name}`,
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
    "/api/admin/directories/zh",
    "/api/admin/directories/en",
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

function checkSearchResults(results, language, page) {
  assert.ok(
    Array.isArray(results) && results.length > 0,
    `${language} search returns results`,
  );
  for (const result of results) {
    assert.ok(
      typeof result.path === "string" &&
        result.path.startsWith(`/${language}/`),
      "Search isolates locale",
    );
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.excerpt, "string");
  }
  assert.ok(
    results.some(
      (result) =>
        result.path === `/${language}/home` && result.title === page.title,
    ),
    "Search finds the current published homepage",
  );
}

// Derive a bounded query from an observed published document. Deployment must
// verify the owner's current content, without relying on or restoring seed data.
export async function checkPublishedSearch(homeHtml, language, getResponse) {
  const home = inertData(homeHtml, "reader-data");
  assert.equal(home.mode, "article");
  assert.equal(home.language, language);
  assert.equal(home.page?.language, language);
  assert.equal(home.page?.path, "home");
  const query = home.page.title;
  assert.ok(
    typeof query === "string" &&
      query.length > 0 &&
      query.length <= 200 &&
      /[\p{L}\p{N}]/u.test(query),
    "Published homepage supplies a bounded searchable title",
  );
  const encodedQuery = encodeURIComponent(query);
  const search = await getResponse(
    `/api/public/search?lang=${language}&q=${encodedQuery}`,
  );
  assert.equal(search.status, 200, `${language} search HTTP status`);
  assert.match(search.headers.get("content-type") ?? "", /application\/json/);
  checkSecurityHeaders(search);
  checkSearchResults((await search.json()).results, language, home.page);

  const searchPage = await getResponse(`/${language}/search?q=${encodedQuery}`);
  assert.equal(searchPage.status, 200, `${language} search page HTTP status`);
  checkReaderHeaders(searchPage);
  const html = await searchPage.text();
  const data = inertData(html, "reader-data");
  checkSettings(data.settings, html);
  assert.equal(data.mode, "search");
  assert.equal(data.language, language);
  assert.equal(data.searchQuery, query);
  checkSearchResults(data.searchResults, language, home.page);
  assert.ok(
    html.includes(`href="/${language}/home"`),
    "Search page renders the published result link",
  );
}

export async function check(getResponse = get) {
  const get = getResponse;
  const page = await get("/");
  const html = await checkLanding(page);
  await checkBranding(html, get);
  for (const language of ["zh", "en"]) {
    await checkLanding(await get(`/?lang=${language}`), language);
    const homeHtml = await checkHome(await get(`/${language}/home`), language);
    await checkPublishedSearch(homeHtml, language, get);
  }
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
  const payload = await health.json();
  assert.deepEqual(Object.keys(payload).sort(), ["ok", "timestamp"]);
  assert.equal(payload.ok, true);
  assert.equal(new Date(payload.timestamp).toISOString(), payload.timestamp);
  assert.ok(Math.abs(Date.now() - Date.parse(payload.timestamp)) < 60_000);
  const missing = await get("/api/not-implemented", {
    headers: { "Sec-Fetch-Mode": "navigate" },
  });
  assert.equal(missing.status, 404, "API must not fall back to SPA HTML");
  assert.deepEqual(await missing.json(), { error: "Not found" });
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
  checkSecurityHeaders(sitemap, true);
  const sitemapXml = await sitemap.text();
  for (const language of ["zh", "en"])
    assert.ok(
      sitemapXml.includes(`<loc>${PUBLIC_ORIGIN}/${language}/home</loc>`),
    );
  for (const entry of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g))
    assert.equal(new URL(entry[1]).origin, PUBLIC_ORIGIN);
  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  checkSecurityHeaders(robots, true);
  const robotsText = await robots.text();
  assert.match(robotsText, /^Allow: \/$/m);
  assert.doesNotMatch(robotsText, /^Disallow: \/$/m);
  assert.ok(robotsText.includes(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`));
  assert.match(robotsText, /^Disallow: \/admin$/m);
  assert.match(robotsText, /^Disallow: \/api\/$/m);
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
    `Smoke passed: ${base} production cover and articles zh/en; canonical metadata and sitemap; public indexing allowed; assets 200; generic health 200; API, reader and file 404; admin shell; anonymous content/revision/event/directory/navigation/redirect/settings/audit/file APIs 401 and editor documents 303; strict anonymous CSP; private routes noindex.`,
  );
}

export async function checkBranding(html, getResponse) {
  const data = inertData(html, "reader-data");
  const branding = parseBranding(JSON.stringify(data.branding));
  for (const asset of Object.values(branding.assets)) {
    const response = await getResponse(asset.path);
    assert.equal(
      response.status,
      200,
      "Branding image must be anonymously accessible",
    );
    assert.equal(
      response.headers.get("content-type")?.split(";")[0],
      asset.mime,
      "Branding MIME",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, asset.bytes, "Branding byte length");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
      "Branding checksum",
    );
  }
  if (branding.assets.ogImage)
    assert.ok(
      html.includes(
        `<meta property="og:image" content="${PUBLIC_ORIGIN}${branding.assets.ogImage.path}">`,
      ),
      "Open Graph image must use the configured absolute HTTPS origin",
    );
  if (branding.assets.favicon)
    assert.ok(
      html.includes(`sizes="32x32" href="${branding.assets.favicon.path}"`),
      "Favicon metadata",
    );
  if (branding.assets.appleTouch)
    assert.ok(
      html.includes(
        `sizes="180x180" href="${branding.assets.appleTouch.path}"`,
      ),
      "Apple Touch metadata",
    );
  return branding;
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
