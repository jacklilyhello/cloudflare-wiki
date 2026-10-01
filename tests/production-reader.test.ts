import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";

const production = {
  ...env,
  APP_ENV: "production",
  PUBLIC_ORIGIN: "https://emby.wiki",
} as Env;

function request(path: string, hostname = "emby.wiki", method = "GET") {
  return worker.fetch(
    new Request(`https://${hostname}${path}`, { method }),
    production,
  );
}

function strictHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "script-src 'self'",
  );
  expect(response.headers.get("Content-Security-Policy")).not.toMatch(
    /unsafe-inline|unsafe-eval/,
  );
}

describe("production indexing and liveness", () => {
  it.each(["emby.wiki", "www.emby.wiki", "cf.emby.wiki"])(
    "allows public bilingual documents to be indexed on %s with a fixed canonical origin",
    async (hostname) => {
      for (const path of ["/", "/zh/home", "/en/home"]) {
        const response = await request(path, hostname);
        expect(response.status).toBe(200);
        strictHeaders(response);
        expect(response.headers.get("X-Robots-Tag")).toBeNull();
        const html = await response.text();
        expect(html).not.toMatch(/<meta\b[^>]*name="robots"/);
        expect(html).toContain(
          `rel="canonical" href="https://emby.wiki${path}"`,
        );
        expect(html).toContain('hreflang="zh"');
        expect(html).toContain('hreflang="en"');
      }
    },
  );

  it("does not trust a request Host for sitemap or robots and allows public crawling", async () => {
    const sitemap = await request("/sitemap.xml", "untrusted.example");
    expect(sitemap.status).toBe(200);
    strictHeaders(sitemap);
    expect(sitemap.headers.get("X-Robots-Tag")).toBeNull();
    const xml = await sitemap.text();
    expect(xml).toContain("https://emby.wiki/zh/home");
    expect(xml).toContain("https://emby.wiki/en/home");
    expect(xml).not.toMatch(/untrusted\.example|\/admin|\/api\//);
    const response = await request("/robots.txt", "untrusted.example");
    expect(response.status).toBe(200);
    strictHeaders(response);
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    const robots = await response.text();
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).not.toMatch(/^Disallow: \/$/m);
    expect(robots).toContain("Disallow: /admin\n");
    expect(robots).toContain("Disallow: /api/\n");
    expect(robots).toContain("Sitemap: https://emby.wiki/sitemap.xml\n");
    expect(robots).not.toContain("untrusted.example");
  });

  it.each([
    "/admin",
    "/admin/login",
    "/zh/search?q=Markdown",
    "/en/search?q=Markdown",
    "/zh/missing",
  ])(
    "keeps non-indexable document %s protected by noindex and strict headers",
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(
        ["/zh/missing", "/admin/login"].includes(path) ? 404 : 200,
      );
      strictHeaders(response);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(await response.text()).toContain(
        'name="robots" content="noindex, nofollow"',
      );
    },
  );

  it.each([
    "/api/admin/session",
    "/api/admin/pages",
    "/api/admin/files",
    "/api/admin/settings",
  ])("retains anonymous authentication protection for %s", async (path) => {
    const response = await request(path);
    expect(response.status).toBe(401);
    strictHeaders(response);
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toMatch(/^__Host-wiki_session=;/);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
  });

  it("returns only ok and current timestamp without revealing deployment metadata", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    strictHeaders(response);
    const health = await response.json<{ ok: boolean; timestamp: string }>();
    expect(Object.keys(health).sort()).toEqual(["ok", "timestamp"]);
    expect(health.ok).toBe(true);
    expect(new Date(health.timestamp).toISOString()).toBe(health.timestamp);
    expect(Math.abs(Date.now() - Date.parse(health.timestamp))).toBeLessThan(
      1000,
    );
  });

  it.each(["/health", "/robots.txt", "/sitemap.xml", "/zh/home"])(
    "keeps bodyless HEAD and rejects mutations for %s",
    async (path) => {
      const response = await request(path, "emby.wiki", "HEAD");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      const mutation = await request(path, "emby.wiki", "POST");
      expect(mutation.status).toBe(405);
      expect(mutation.headers.get("Allow")).toBe("GET, HEAD");
    },
  );

  it("retains the explicit test environment crawler block", async () => {
    const testEnv = {
      ...env,
      APP_ENV: "test",
      PUBLIC_ORIGIN: "https://cf.emby.wiki",
    } as unknown as Env;
    const response = await worker.fetch(
      new Request("https://cf.emby.wiki/robots.txt"),
      testEnv,
    );
    expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });
});
