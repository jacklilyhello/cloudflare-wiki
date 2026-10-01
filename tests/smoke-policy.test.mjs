import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  createSmokeGet,
  LOCAL_SMOKE_BASE_URL,
  validateSmokeBaseUrl,
} from "../scripts/smoke-policy.mjs";
import { checkAdmin, checkHome, checkLanding } from "../scripts/smoke-test.mjs";

test("allows localhost and all three production Custom Domains", () => {
  for (const base of [
    LOCAL_SMOKE_BASE_URL,
    "https://emby.wiki",
    "https://www.emby.wiki",
    "https://cf.emby.wiki",
  ])
    assert.equal(validateSmokeBaseUrl(base).origin, base);
});

test("rejects workers.dev, arbitrary origins and malformed smoke targets", () => {
  for (const base of [
    "https://example.com",
    "http://emby.wiki",
    "https://emby.wiki/",
    "https://emby.wiki/health",
    "https://emby.wiki?bypass=1",
    "https://user:password@emby.wiki",
    "https://cf.emby.wiki:8443",
    "https://cloudflare-wiki.account-subdomain.workers.dev",
    "https://cloudflare-wiki.account-subdomain.workers.dev/health",
  ])
    assert.throws(() => validateSmokeBaseUrl(base));
});

test("WWW smoke verifies the exact canonical path and query before checking the application", async () => {
  const calls = [];
  const get = createSmokeGet(
    "https://www.emby.wiki",
    async (url, options) => {
      calls.push(url.href);
      assert.equal(options.redirect, "manual");
      return Response.json({ ok: true });
    },
    async (url, options) => {
      calls.push(url.href);
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 301,
        headers: { Location: "https://emby.wiki/zh/search?q=Emby" },
      });
    },
  );
  assert.equal((await get("/zh/search?q=Emby")).status, 200);
  assert.deepEqual(calls, [
    "https://www.emby.wiki/zh/search?q=Emby",
    "https://emby.wiki/zh/search?q=Emby",
  ]);
});

test("WWW smoke rejects missing, external and lossy redirects without requesting their target", async () => {
  for (const location of [
    "https://attacker.example/zh/home?q=keep",
    "http://emby.wiki/zh/home?q=keep",
    "https://emby.wiki/en/home?q=keep",
    "https://emby.wiki/zh/home",
    "/zh/home?q=keep",
    "https://user:password@emby.wiki/zh/home?q=keep",
  ]) {
    const get = createSmokeGet(
      "https://www.emby.wiki",
      () => assert.fail("Unexpected follow-up request"),
      async () =>
        new Response(null, { status: 301, headers: { Location: location } }),
    );
    await assert.rejects(get("/zh/home?q=keep"));
  }
});

test("smoke rejects cross-origin requests, credentials and writes before invoking transport", async () => {
  const get = createSmokeGet("https://emby.wiki", () =>
    assert.fail("Unexpected request"),
  );
  for (const [path, options] of [
    ["https://attacker.example/health"],
    ["//attacker.example/health"],
    ["/api/admin/login", { method: "POST" }],
    ["/api/admin/session", { headers: { Authorization: "fixture" } }],
    ["/api/admin/session", { headers: { Cookie: "fixture" } }],
  ])
    await assert.rejects(get(path, options));
});

test("smoke inspects editor redirects and fails unexpected document redirects", async () => {
  const get = createSmokeGet(
    "https://emby.wiki",
    async () =>
      new Response(null, {
        status: 303,
        headers: { Location: "/admin?returnTo=%2Fadmin%2Fpages%2Fnew" },
      }),
  );
  await assert.rejects(get("/"));
  assert.equal(
    (await get("/admin/pages/new", { redirect: "manual" })).status,
    303,
  );
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
  "/api/admin/files",
  "/api/admin/directories/zh",
  "/api/admin/directories/en",
  "/api/admin/files/00000000-0000-4000-8000-000000000000/download",
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
        `<html data-theme="system" data-accent="forest"><head>${appearanceScript}<title>Administration · Emby Wiki</title></head><body><div id="root"></div><script src="/assets/app.js"></script><script id="site-settings" type="application/json">${JSON.stringify(siteSettings)}</script><script id="deployment-branding" type="application/json">{"version":1,"assets":{},"locales":{}}</script></body></html>`,
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
      "/api/admin/files",
      "/api/admin/directories/zh",
      "/api/admin/directories/en",
      "/api/admin/files/00000000-0000-4000-8000-000000000000/download",
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
  return `<html lang="${language}" data-theme="system" data-accent="forest"><head>${appearanceScript}<title>Home · ${identity.name}</title><link rel="canonical" href="https://emby.wiki/${language}/home"><meta property="og:site_name" content="${identity.name}"><meta property="og:title" content="Home · ${identity.name}"><meta name="description" content="Article description"><link rel="alternate" hreflang="zh" href="https://emby.wiki/zh/home"><link rel="alternate" hreflang="en" href="https://emby.wiki/en/home"></head><body><article><h1>Home</h1><a href="#section">Section</a></article><script id="reader-data" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

test("homepage smoke follows configured language while checking both explicit article routes", async () => {
  for (const language of ["zh", "en"]) {
    const response = (html) =>
      new Response(html, {
        headers: {
          ...adminHeaders,
          "X-Robots-Tag": "index, follow",
          "Content-Type": "text/html",
        },
      });
    await checkHome(response(homepage(language)));
    await assert.rejects(
      checkHome(
        new Response(homepage(language), {
          headers: { ...adminHeaders, "Content-Type": "text/html" },
        }),
      ),
    );
    await checkHome(
      response(homepage(language, language === "zh" ? "en" : "zh")),
      language,
    );
    for (const broken of [
      homepage(language, language === "zh" ? "en" : "zh"),
      homepage(language).replace('rel="canonical"', 'rel="removed"'),
      homepage(language).replace(
        `https://emby.wiki/${language}/home`,
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
      homepage(language).replace(
        "<head>",
        '<head><meta name="robots" content="noindex, nofollow">',
      ),
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
        document: { documentElement: { dataset }, querySelector: () => null },
        localStorage: { getItem: () => saved },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
      });
      assert.deepEqual(dataset, {
        theme: ["light", "dark"].includes(saved) ? saved : theme,
        accent: "ocean",
      });
    }
  const dataset = { theme: "dark", accent: "plum" };
  runInNewContext(source, {
    document: { documentElement: { dataset }, querySelector: () => null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
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

test("cover smoke rejects old article routing, wrong canonical metadata and broken language choices", async () => {
  for (const language of ["zh", "en"]) {
    const identity = siteSettings.locales[language];
    const data = {
      settings: { ...siteSettings, defaultLanguage: language },
      language,
      mode: "landing",
      page: null,
      rendered: null,
      navigation: [],
      searchResults: [],
      translations: { zh: "/?lang=zh", en: "/?lang=en" },
    };
    const html = `<html lang="${language}" data-theme="system" data-accent="forest"><head>${appearanceScript}<title>${identity.name} · ${language === "zh" ? "Emby 技术手册" : "The Emby Handbook"}</title><link rel="canonical" href="https://emby.wiki/"><link rel="alternate" hreflang="zh" href="https://emby.wiki/?lang=zh"><link rel="alternate" hreflang="en" href="https://emby.wiki/?lang=en"><link rel="alternate" hreflang="x-default" href="https://emby.wiki/"><meta property="og:url" content="https://emby.wiki/"><meta property="og:type" content="website"><meta name="theme-color" content="#f5f4ee"><meta name="description" content="${identity.description}"></head><body><main id="cover-content"><h1 id="cover-title">${identity.name}</h1><a href="/${language}/home">Continue</a><a href="/?lang=zh">中文</a><a href="/?lang=en">English</a></main><script id="reader-data" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    const response = (text) =>
      new Response(text, {
        headers: {
          ...adminHeaders,
          "X-Robots-Tag": "index, follow",
          "Content-Type": "text/html",
        },
      });
    await checkLanding(response(html));
    for (const broken of [
      homepage(language),
      html.replace('rel="canonical"', 'rel="missing"'),
      html.replace('content="website"', 'content="article"'),
      html.replace(
        'href="https://emby.wiki/"',
        'href="https://emby.wiki/zh/home"',
      ),
      html.replace(`href="/${language}/home"`, 'href="/admin"'),
      html.replace('href="/?lang=en"', 'href="/?lang=fr"'),
      html.replace('name="theme-color"', 'name="missing"'),
      html.replace(
        "<head>",
        '<head><meta name="robots" content="noindex, nofollow">',
      ),
    ])
      await assert.rejects(checkLanding(response(broken)));
    await assert.rejects(
      checkLanding(
        new Response(null, { status: 302, headers: { Location: "/zh/home" } }),
      ),
    );
  }
});

test("browser chrome follows first-paint theme and subsequent system changes, with visitor choices winning", () => {
  const source = readFileSync(
    new URL("../public/assets/site-appearance.js", import.meta.url),
    "utf8",
  );
  for (const systemDark of [false, true]) {
    let update;
    const system = {
      matches: systemDark,
      addEventListener: (_, callback) => {
        update = callback;
      },
    };
    const meta = {
      dataset: { light: "#f5f4ee", dark: "#091410" },
      content: "#f5f4ee",
    };
    const dataset = { theme: "system" };
    runInNewContext(source, {
      document: { documentElement: { dataset }, querySelector: () => meta },
      localStorage: { getItem: () => null },
      matchMedia: () => system,
    });
    assert.equal(
      meta.content,
      systemDark ? meta.dataset.dark : meta.dataset.light,
    );
    system.matches = !systemDark;
    update();
    assert.equal(
      meta.content,
      systemDark ? meta.dataset.light : meta.dataset.dark,
    );
    dataset.theme = "dark";
    system.matches = false;
    update();
    assert.equal(meta.content, meta.dataset.dark);
  }
});
