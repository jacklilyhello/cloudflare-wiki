import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  LOCAL_SMOKE_BASE_URL,
  validateSmokeBaseUrl,
  workersDevBaseUrl,
} from "../scripts/smoke-policy.mjs";
import { checkAdmin, checkHome } from "../scripts/smoke-test.mjs";

const accountSubdomain = "account-subdomain";
const workersDevBase = workersDevBaseUrl(accountSubdomain);

test("allows localhost and the fixed test Custom Domain", () => {
  assert.equal(
    validateSmokeBaseUrl(LOCAL_SMOKE_BASE_URL).origin,
    LOCAL_SMOKE_BASE_URL,
  );
  assert.equal(
    validateSmokeBaseUrl("https://cf.emby.wiki").hostname,
    "cf.emby.wiki",
  );
});

test("allows only the exact Cloudflare-derived workers.dev smoke URL", () => {
  assert.equal(
    validateSmokeBaseUrl(workersDevBase, accountSubdomain).href,
    `${workersDevBase}/`,
  );
  assert.throws(() =>
    validateSmokeBaseUrl(
      "https://cloudflare-wiki.other-account.workers.dev",
      accountSubdomain,
    ),
  );
  assert.throws(() => validateSmokeBaseUrl(workersDevBase));
});

test("rejects arbitrary external, production, and malformed smoke targets", () => {
  for (const base of [
    "https://example.com",
    "https://emby.wiki",
    "https://cf.emby.wiki/",
    "https://cloudflare-wiki.account-subdomain.workers.dev/health",
  ]) {
    assert.throws(() => validateSmokeBaseUrl(base, accountSubdomain));
  }
});

test("rejects invalid Cloudflare Workers account subdomains", () => {
  for (const subdomain of [
    "",
    "-invalid",
    "invalid-",
    "with.dot",
    "UPPERCASE",
  ]) {
    assert.throws(() => workersDevBaseUrl(subdomain));
  }
});

const adminHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'",
};

const adminApiPaths = [
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
];
const editorPaths = [
  "/admin/pages/new",
  "/admin/pages/starter-home-en/history",
];

const siteSettings = {
  locales: {
    zh: { name: "Emby Wiki", description: "技术文档" },
    en: { name: "Emby Wiki", description: "Documentation" },
  },
  defaultLanguage: "zh",
  theme: "system",
  accent: "forest",
  logo: "emby",
};
const appearanceScript = '<script src="/assets/site-appearance.js"></script>';

function adminResponses(
  status = { initialized: false, setupAvailable: false },
) {
  return new Map([
    [
      "/admin",
      new Response(
        `<html data-theme="system" data-accent="forest"><head>${appearanceScript}<title>Administration · Emby Wiki</title></head><body><div id="root"></div><script src="/assets/app.js"></script><script id="site-settings" type="application/json">${JSON.stringify(siteSettings)}</script></body></html>`,
        { headers: { ...adminHeaders, "Content-Type": "text/html" } },
      ),
    ],
    ...adminApiPaths.map((path) => [
      path,
      Response.json(
        { error: "Sign in required" },
        { status: 401, headers: adminHeaders },
      ),
    ]),
    ...editorPaths.map((path) => [
      path,
      new Response(null, {
        status: 303,
        headers: {
          ...adminHeaders,
          Location: `/admin?returnTo=${encodeURIComponent(path)}`,
        },
      }),
    ]),
    ["/api/admin/setup", Response.json(status, { headers: adminHeaders })],
  ]);
}

function getFixture(responses, calls = []) {
  return async (path, options) => {
    // The smoke helper cannot carry credentials or select a mutation method.
    assert.deepEqual(
      options,
      editorPaths.includes(path) ? { redirect: "manual" } : undefined,
    );
    calls.push(path);
    assert.ok(responses.has(path), `Unexpected smoke request: ${path}`);
    return responses.get(path);
  };
}

test("admin smoke accepts all lifecycle states using only anonymous reads", async () => {
  for (const status of [
    { initialized: false, setupAvailable: false },
    { initialized: false, setupAvailable: true },
    { initialized: true, setupAvailable: false },
  ]) {
    const calls = [];
    await checkAdmin(getFixture(adminResponses(status), calls));
    assert.deepEqual(calls, [
      "/admin",
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
      "/admin/pages/new",
      "/admin/pages/starter-home-en/history",
      "/api/admin/setup",
    ]);
  }
});

test("admin smoke rejects an anonymous API success or leaked response fields", async () => {
  for (const path of adminApiPaths) {
    for (const response of [
      Response.json({ error: "Sign in required" }, { headers: adminHeaders }),
      Response.json(
        { error: "Sign in required", pages: [] },
        { status: 401, headers: adminHeaders },
      ),
    ]) {
      const responses = adminResponses();
      responses.set(path, response);
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
});

test("admin smoke rejects malformed or credential-bearing setup status", async () => {
  for (const status of [
    null,
    { initialized: "false", setupAvailable: false },
    { initialized: false },
    { initialized: true, setupAvailable: true },
    { initialized: false, setupAvailable: true, token: "fixture-only" },
  ]) {
    await assert.rejects(checkAdmin(getFixture(adminResponses(status))));
  }
  const responses = adminResponses();
  responses
    .get("/api/admin/setup")
    .headers.set("Set-Cookie", "unexpected=fixture-only");
  await assert.rejects(checkAdmin(getFixture(responses)));
});

test("admin smoke rejects reader fallback and missing security headers", async () => {
  const fallback = adminResponses();
  fallback.set(
    "/admin",
    new Response("<article>Emby Wiki</article>", {
      headers: { ...adminHeaders, "Content-Type": "text/html" },
    }),
  );
  await assert.rejects(checkAdmin(getFixture(fallback)));
  for (const path of [
    "/admin",
    ...adminApiPaths,
    ...editorPaths,
    "/api/admin/setup",
  ]) {
    for (const header of [
      "Cache-Control",
      "X-Robots-Tag",
      "Content-Security-Policy",
    ]) {
      const responses = adminResponses();
      responses.get(path).headers.delete(header);
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
});

test("admin smoke rejects editor data, session issuance, unsafe redirects, and relaxed anonymous CSP", async () => {
  for (const path of editorPaths) {
    const redirect = `/admin?returnTo=${encodeURIComponent(path)}`;
    for (const response of [
      new Response("editor source", { headers: adminHeaders }),
      new Response("private document", {
        status: 303,
        headers: { ...adminHeaders, Location: redirect },
      }),
      new Response(null, {
        status: 303,
        headers: { ...adminHeaders, Location: "https://attacker.invalid" },
      }),
      new Response(null, {
        status: 303,
        headers: {
          ...adminHeaders,
          Location: redirect,
          "Set-Cookie": "unexpected=fixture-only",
        },
      }),
    ]) {
      const responses = adminResponses();
      responses.set(path, response);
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
  for (const path of [
    "/admin",
    ...adminApiPaths,
    ...editorPaths,
    "/api/admin/setup",
  ]) {
    for (const directive of [
      "style-src-attr 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-eval'",
    ]) {
      const responses = adminResponses();
      responses
        .get(path)
        .headers.set(
          "Content-Security-Policy",
          `${adminHeaders["Content-Security-Policy"]}; ${directive}`,
        );
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
});

function homepage(language, defaultLanguage = language) {
  const settings = { ...siteSettings, defaultLanguage };
  const identity = settings.locales[language];
  const data = {
    settings,
    language,
    mode: "article",
    page: {
      language,
      path: "home",
      title: "Home",
      description: "Article description",
    },
  };
  return `<html lang="${language}" data-theme="system" data-accent="forest"><head>${appearanceScript}<title>Home · ${identity.name}</title><link rel="canonical" href="https://cf.emby.wiki/${language}/home"><meta property="og:site_name" content="${identity.name}"><meta property="og:title" content="Home · ${identity.name}"><meta name="description" content="Article description"><link rel="alternate" hreflang="zh" href="https://cf.emby.wiki/zh/home"><link rel="alternate" hreflang="en" href="https://cf.emby.wiki/en/home"></head><body><article><h1>Home</h1><a href="#section">Section</a></article><script id="reader-data" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

test("homepage smoke follows configured language while checking both explicit article routes", async () => {
  for (const language of ["zh", "en"]) {
    const response = (html) =>
      new Response(html, {
        headers: { ...adminHeaders, "Content-Type": "text/html" },
      });
    await checkHome(response(homepage(language)));
    await checkHome(
      response(homepage(language, language === "zh" ? "en" : "zh")),
      language,
    );
    for (const broken of [
      homepage(language, language === "zh" ? "en" : "zh"),
      homepage(language).replace('rel="canonical"', 'rel="removed"'),
      homepage(language).replace(
        `https://cf.emby.wiki/${language}/home`,
        `https://attacker.invalid/${language}/home`,
      ),
      homepage(language).replace('property="og:title"', 'property="removed"'),
      homepage(language).replace(
        'property="og:site_name"',
        'property="removed"',
      ),
      homepage(language).replace('name="description"', 'name="removed"'),
      homepage(language).replace('hreflang="en"', 'hreflang="fr"'),
      homepage(language).replace("<article>", "<section>"),
    ])
      await assert.rejects(checkHome(response(broken)));
  }
});

test("first-paint theme script accepts only explicit visitor choices and preserves server settings on storage failure", () => {
  const source = readFileSync(
    new URL("../public/assets/site-appearance.js", import.meta.url),
    "utf8",
  );
  for (const theme of ["system", "light", "dark"])
    for (const saved of [
      null,
      "system",
      "light",
      "dark",
      'dark" onclick="alert(1)',
    ]) {
      const dataset = { theme, accent: "ocean" };
      runInNewContext(source, {
        document: { documentElement: { dataset } },
        localStorage: { getItem: () => saved },
      });
      assert.deepEqual(dataset, {
        theme: ["light", "dark"].includes(saved) ? saved : theme,
        accent: "ocean",
      });
    }
  const dataset = { theme: "dark", accent: "plum" };
  runInNewContext(source, {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem() {
        throw new Error("Storage blocked");
      },
    },
  });
  assert.deepEqual(dataset, { theme: "dark", accent: "plum" });
});

test("all fixed accent palettes retain readable text contrast in light and dark schemes", () => {
  const css = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  function luminance(color) {
    const channels = color
      .slice(1)
      .match(/../g)
      .map((hex) => Number.parseInt(hex, 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function contrast(first, second) {
    const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (values[1] + 0.05) / (values[0] + 0.05);
  }
  for (const selector of [
    ":root",
    ':root[data-accent="ocean"]',
    ':root[data-accent="plum"]',
  ]) {
    const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    const value = (name) =>
      new RegExp(`--${name}: (#[0-9a-f]{6});`).exec(block)?.[1];
    for (const [theme, background] of [
      ["light", "#ffffff"],
      ["dark", "#151a18"],
    ]) {
      assert.ok(
        contrast(value(`accent-${theme}`), background) >= 4.5,
        `${selector} ${theme} body contrast`,
      );
      assert.ok(
        contrast(value(`accent-${theme}`), value(`accent-soft-${theme}`)) >=
          4.5,
        `${selector} ${theme} selected text contrast`,
      );
    }
  }
});
