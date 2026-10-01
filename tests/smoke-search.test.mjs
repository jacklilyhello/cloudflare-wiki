import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPublishedSearch } from "../scripts/smoke-test.mjs";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'",
};
const settings = {
  locales: {
    zh: { name: "Wiki", description: "指南" },
    en: { name: "Wiki", description: "Guides" },
  },
  defaultLanguage: "zh",
  theme: "system",
  accent: "forest",
  logo: "emby",
};

function document(data, body = "") {
  return `<html data-theme="system" data-accent="forest"><head><script src="/assets/site-appearance.js"></script></head><body>${body}<script id="reader-data" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

function fixture(language, title, overrides = {}) {
  const page = { language, path: "home", title };
  const result = {
    path: `/${language}/home`,
    title,
    excerpt: "Published text",
  };
  const query = encodeURIComponent(title);
  const apiPath = `/api/public/search?lang=${language}&q=${query}`;
  const readerPath = `/${language}/search?q=${query}`;
  const calls = [];
  const home = document({ mode: "article", language, page });
  const get = async (path, options) => {
    assert.equal(options, undefined, "Search smoke uses anonymous GETs only");
    calls.push(path);
    if (path === apiPath)
      return new Response(
        JSON.stringify({ results: overrides.apiResults ?? [result] }),
        {
          status: overrides.apiStatus ?? 200,
          headers: overrides.headers ?? headers,
        },
      );
    assert.equal(
      path,
      readerPath,
      "Query remains encoded in the expected locale route",
    );
    return new Response(
      document(
        {
          settings,
          mode: "search",
          language,
          searchQuery: title,
          searchResults: [result],
          ...overrides.readerData,
        },
        overrides.readerBody ?? `<a href="/${language}/home">${language}</a>`,
      ),
      { headers: { ...headers, "Content-Type": "text/html" } },
    );
  };
  return { home, get, calls, apiPath, readerPath };
}

test("search smoke checks current bilingual published titles with no seed data or mutations", async () => {
  for (const [language, title] of [
    ["zh", "什么是 Emby？"],
    ["en", "What Is Emby?"],
    ["zh", "家庭媒体：配置 & 使用"],
    ["en", "Media guides & tips? #1"],
  ]) {
    const f = fixture(language, title);
    await checkPublishedSearch(f.home, language, f.get);
    assert.deepEqual(f.calls, [f.apiPath, f.readerPath]);
  }
});

test("search smoke rejects empty, cross-language, missing or malformed published results", async () => {
  for (const apiResults of [
    [],
    [{ path: "/en/home", title: "指南", excerpt: "Text" }],
    [{ path: "/zh/other", title: "指南", excerpt: "Text" }],
    [{ path: "/zh/home", title: "Stale title", excerpt: "Text" }],
    [{ path: "/zh/home", title: "指南", excerpt: null }],
  ]) {
    const f = fixture("zh", "指南", { apiResults });
    await assert.rejects(checkPublishedSearch(f.home, "zh", f.get));
  }
});

test("search smoke rejects HTTP failures or missing public security protections", async () => {
  const failure = fixture("en", "Media guide", { apiStatus: 503 });
  await assert.rejects(checkPublishedSearch(failure.home, "en", failure.get));
  for (const removed of Object.keys(headers)) {
    const incomplete = { ...headers };
    delete incomplete[removed];
    const f = fixture("en", "Media guide", { headers: incomplete });
    await assert.rejects(checkPublishedSearch(f.home, "en", f.get));
  }
});

test("search smoke rejects a reader fallback, wrong query, missing results or missing result links", async () => {
  for (const readerData of [
    { mode: "article" },
    { language: "en" },
    { searchQuery: "Stale query" },
    { searchResults: [] },
  ]) {
    const f = fixture("zh", "中文指南", { readerData });
    await assert.rejects(checkPublishedSearch(f.home, "zh", f.get));
  }
  const f = fixture("en", "Media guide", {
    readerBody: "<p>No result link</p>",
  });
  await assert.rejects(checkPublishedSearch(f.home, "en", f.get));
});

test("search smoke rejects a cover, invalid locale or unbounded title before requesting", async () => {
  for (const home of [
    { mode: "landing", language: "zh", page: null },
    {
      mode: "article",
      language: "en",
      page: { language: "en", path: "home", title: "Home" },
    },
    {
      mode: "article",
      language: "zh",
      page: { language: "zh", path: "home", title: "a".repeat(201) },
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      checkPublishedSearch(document(home), "zh", async () => {
        calls++;
      }),
    );
    assert.equal(calls, 0);
  }
});
