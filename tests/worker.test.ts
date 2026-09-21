import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ReaderData, SearchResult } from "../shared/reader";

function expectPrivateTestResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

function readerData(html: string): ReaderData {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const payload = scripts.find((script) =>
    /\bid="reader-data"/.test(script[1] ?? ""),
  );
  expect(payload, "Reader HTML includes inert hydration data").toBeDefined();
  expect(payload?.[1]).toContain('type="application/json"');
  return JSON.parse(payload?.[2] ?? "null") as ReaderData;
}

describe("Worker HTTP boundary", () => {
  it("serves uncached health JSON even for browser navigation", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "cloudflare-wiki",
      environment: "test",
      revision: "local",
    });
  });
  it("supports bodyless HEAD health checks", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
  it("rejects mutations on the health endpoint", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });
  it.each(["/api", "/api/missing"])(
    "returns JSON 404 for unimplemented %s",
    async (path) => {
      const response = await exports.default.fetch(
        `https://example.com${path}`,
        { headers: { "Sec-Fetch-Mode": "navigate" } },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    },
  );
});

describe("Public reader HTTP boundary", () => {
  it.each(["/", "/zh/home", "/zh/guide/reading", "/zh/guide/markdown"])(
    "renders article content before JavaScript executes for %s",
    async (path) => {
      const response = await exports.default.fetch(
        `https://example.com${path}`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expectPrivateTestResponse(response);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Referrer-Policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      const policy = response.headers.get("Content-Security-Policy");
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("object-src 'none'");
      expect(policy).not.toContain("'unsafe-inline'");
      expect(policy).not.toContain("'unsafe-eval'");
      const html = await response.text();
      expect(html).toMatch(/<html[^>]*lang="zh"/);
      expect(html).toMatch(/<article\b/);
      expect(html).toMatch(/<h1\b[^>]*>[^<]+/);
      expect(html).toContain("Emby Wiki");
      const data = readerData(html);
      expect(data.mode).toBe("article");
      expect(data.language).toBe("zh");
      expect(data.page?.language).toBe("zh");
      expect(data.rendered?.toc.length).toBeGreaterThan(0);
      for (const heading of data.rendered?.toc ?? []) {
        expect(html).toContain(`id="${heading.id}"`);
        expect(html).toContain(`href="#${heading.id}"`);
      }
    },
  );

  it("renders English content and stable translation relationships", async () => {
    const response = await exports.default.fetch("https://example.com/en/home");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<html[^>]*lang="en"/);
    const data = readerData(html);
    expect(data.language).toBe("en");
    expect(data.page?.language).toBe("en");
    expect(data.translations.zh).toBe("/zh/home");
    expect(data.translations.en).toBe("/en/home");
  });

  it.each(["/fr/home", "/zh/missing"])(
    "returns a real HTML 404 for %s",
    async (path) => {
      const response = await exports.default.fetch(
        `https://example.com${path}`,
        {
          headers: { "Sec-Fetch-Mode": "navigate" },
        },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expectPrivateTestResponse(response);
      const data = readerData(await response.text());
      expect(data.mode).toBe("not-found");
      expect(data.page).toBeNull();
    },
  );

  it.each(["/", "/en/home", "/zh/search?q=Markdown", "/sitemap.xml"])(
    "supports a bodyless HEAD response for %s",
    async (path) => {
      const response = await exports.default.fetch(
        `https://example.com${path}`,
        {
          method: "HEAD",
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expectPrivateTestResponse(response);
    },
  );

  it.each(["/", "/zh/home", "/zh/search", "/sitemap.xml"])(
    "rejects POST requests to read-only route %s",
    async (path) => {
      const response = await exports.default.fetch(
        `https://example.com${path}`,
        {
          method: "POST",
        },
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
      expectPrivateTestResponse(response);
    },
  );

  it("uses the fixed test origin for canonical metadata and sitemap URLs", async () => {
    const page = await exports.default.fetch(
      "https://attacker.invalid/zh/home",
    );
    const html = await page.text();
    expect(html).toMatch(
      /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/cf\.emby\.wiki\/zh\/home"/,
    );
    expect(html).toMatch(/<meta\b[^>]*name="description"[^>]*content="[^"]+"/);
    expect(html).toMatch(/<meta\b[^>]*property="og:title"[^>]*content="[^"]+"/);
    expect(html).not.toContain("attacker.invalid");

    const sitemap = await exports.default.fetch(
      "https://attacker.invalid/sitemap.xml",
    );
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("Content-Type")).toContain("xml");
    expectPrivateTestResponse(sitemap);
    const xml = await sitemap.text();
    expect(xml).toContain("https://cf.emby.wiki/zh/home");
    expect(xml).toContain("https://cf.emby.wiki/en/home");
    expect(xml).not.toContain("attacker.invalid");
    expect(xml).not.toContain("/admin");
  });
});

describe("Public search boundary", () => {
  it.each(["zh", "en"])(
    "returns useful results only in the requested language %s",
    async (language) => {
      const response = await exports.default.fetch(
        `https://example.com/api/public/search?lang=${language}&q=Markdown`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expectPrivateTestResponse(response);
      const payload = (await response.json()) as { results: SearchResult[] };
      expect(payload.results.length).toBeGreaterThan(0);
      for (const result of payload.results) {
        expect(result.path).toMatch(new RegExp(`^/${language}/`));
        expect(result.title).toEqual(expect.any(String));
        expect(result.description).toEqual(expect.any(String));
        expect(result.excerpt).toEqual(expect.any(String));
        expect(result.tags).toEqual(expect.any(Array));
        expect(Object.keys(result).sort()).toEqual([
          "description",
          "excerpt",
          "path",
          "tags",
          "title",
        ]);
      }
    },
  );

  it.each(["lang=fr&q=Markdown", `lang=zh&q=${"x".repeat(201)}`])(
    "rejects invalid or unbounded search input: %s",
    async (query) => {
      const response = await exports.default.fetch(
        `https://example.com/api/public/search?${query}`,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expectPrivateTestResponse(response);
    },
  );

  it("server-renders search results without requiring JavaScript", async () => {
    const response = await exports.default.fetch(
      "https://example.com/zh/search?q=Markdown",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    const data = readerData(html);
    expect(data.mode).toBe("search");
    expect(data.searchQuery).toBe("Markdown");
    expect(data.searchResults.length).toBeGreaterThan(0);
    for (const result of data.searchResults) {
      expect(html).toContain(`href="${result.path}"`);
    }
  });

  it("escapes reflected search text and script-closing hydration data", async () => {
    const query = '</script><img src=x onerror="alert(1)">';
    const response = await exports.default.fetch(
      `https://example.com/zh/search?q=${encodeURIComponent(query)}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(query);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;/script&gt;");
    expect(readerData(html).searchQuery).toBe(query);
  });
});
