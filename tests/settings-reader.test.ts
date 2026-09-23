import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReaderData, SearchResult } from "../shared/reader";
import {
  INITIAL_SITE_SETTINGS,
  parseSiteSettingsValues,
  type SiteSettingsValues,
} from "../shared/settings";
import { effectiveTheme } from "../src/site-appearance";
import { adminShell } from "../worker/admin";
import type { ContentService } from "../worker/content/service";
import { publicSearch, renderReader } from "../worker/reader";
import { escapeHtml } from "../worker/security";
import { SettingsService } from "../worker/settings/service";
import { contentFixture } from "./content-fixture";

let settingsService: SettingsService;
let content: ContentService;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const fixture = await contentFixture(env.DB);
  content = fixture.service;
  settingsService = new SettingsService(env.DB, fixture.access);
});

const identity = {
  zh: { name: "知识花园", description: "中文站点说明" },
  en: { name: "Knowledge Garden", description: "English site description" },
};
async function configure(values: Partial<SiteSettingsValues> = {}) {
  const current = await settingsService.get();
  const next = { ...INITIAL_SITE_SETTINGS, locales: identity, ...values };
  await settingsService.update({ ...next, expectedVersion: current.version });
  return next;
}
function readInert(html: string, id = "reader-data"): unknown {
  const match = new RegExp(
    `<script id="${id}" type="application/json">([\\s\\S]*?)</script>`,
  ).exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match?.[1] ?? "null");
}
function readReader(html: string) {
  return readInert(html) as ReaderData;
}
function request(path: string, method = "GET") {
  return exports.default.fetch(`https://example.com${path}`, { method });
}

describe("public site settings", () => {
  it("serves the configured home language and keeps explicit bilingual routes, SEO and sitemap stable", async () => {
    const settings = await configure({
      defaultLanguage: "en",
      theme: "dark",
      accent: "ocean",
      logo: "book",
    });
    for (const [path, language] of [
      ["/", "en"],
      ["/en/home", "en"],
      ["/zh/home", "zh"],
    ] as const) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
      expect(response.headers.get("Content-Security-Policy")).not.toMatch(
        /unsafe-inline|unsafe-eval/,
      );
      const html = await response.text();
      const data = readReader(html);
      expect(data.settings).toEqual(settings);
      expect(parseSiteSettingsValues(data.settings)).toEqual(settings);
      expect(data.language).toBe(language);
      expect(data.page?.language).toBe(language);
      expect(data.translations).toEqual({ zh: "/zh/home", en: "/en/home" });
      expect(html).toContain(`lang="${language}"`);
      expect(html).toContain('data-theme="dark"');
      expect(html).toContain('data-accent="ocean"');
      expect(html).toContain(
        `<title>${data.page?.title} · ${identity[language].name}</title>`,
      );
      expect(html).toContain(
        `<meta property="og:site_name" content="${identity[language].name}">`,
      );
      expect(html).toContain(
        `<link rel="canonical" href="https://cf.emby.wiki/${language}/home">`,
      );
      expect(html).toContain(
        `<meta name="description" content="${escapeHtml(data.page?.description ?? "")}">`,
      );
      expect(html).toContain(
        `aria-label="${identity[language].name}${language === "zh" ? " 首页" : " home"}"`,
      );
      expect(html).toContain(
        `<footer class="site-footer"><span>${identity[language].name}</span><span>${identity[language].description}</span></footer>`,
      );
      expect(html).toContain('<svg class="site-mark"');
      expect(
        html.indexOf('<script src="/assets/site-appearance.js"></script>'),
      ).toBeLessThan(html.indexOf("<title>"));
      expect(html).not.toContain("https://example.com");
    }
    const sitemap = await (await request("/sitemap.xml")).text();
    expect(sitemap).toContain("https://cf.emby.wiki/zh/home");
    expect(sitemap).toContain("https://cf.emby.wiki/en/home");
    const head = await request("/", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("uses the default language only for omitted search language and unsupported document language", async () => {
    await configure({ defaultLanguage: "en" });
    for (const [suffix, language] of [
      ["", "en"],
      ["&lang=zh", "zh"],
      ["&lang=en", "en"],
    ] as const) {
      const response = await request(`/api/public/search?q=Markdown${suffix}`);
      expect(response.status).toBe(200);
      const { results } = (await response.json()) as {
        results: SearchResult[];
      };
      expect(results.length).toBeGreaterThan(0);
      expect(
        results.every((result) => result.path.startsWith(`/${language}/`)),
      ).toBe(true);
    }
    for (const language of ["fr", "", "EN"])
      expect(
        (await request(`/api/public/search?lang=${language}`)).status,
      ).toBe(400);
    const missing = await request("/fr/home");
    expect(missing.status).toBe(404);
    const missingHtml = await missing.text();
    expect(readReader(missingHtml).language).toBe("en");
    expect(missingHtml).toContain("This page could not be found");
    expect(missingHtml).toContain(
      '<meta name="description" content="English site description">',
    );
    const searchHtml = await (await request("/zh/search?q=Markdown")).text();
    expect(readReader(searchHtml).language).toBe("zh");
    expect(searchHtml).toContain(
      '<meta name="description" content="中文站点说明">',
    );
  });

  it("uses the locale description only when an article has none and allows no logo", async () => {
    await configure({ logo: "none", theme: "light", accent: "plum" });
    const page = await content.createTranslation({
      language: "en",
      path: "no-description",
      title: "An article",
      description: "",
      markdown: "## Heading\n\nPublished body",
      tags: [],
    });
    await content.publish(page.id, page.version, page.draftRevisionId ?? "");
    const html = await (await request("/en/no-description")).text();
    expect(html).toContain(
      '<meta name="description" content="English site description">',
    );
    expect(html).toContain(
      '<p class="article-description">English site description</p>',
    );
    expect(html).not.toContain('class="site-mark"');
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('data-accent="plum"');
  });

  it("escapes site names and descriptions in reader metadata, branded markup and both inert payloads", async () => {
    const attack = '</script><img src=x onerror="alert(1)">&';
    const settings = await configure({
      locales: {
        zh: { name: attack, description: attack },
        en: { name: attack, description: attack },
      },
    });
    for (const path of ["/zh/search", "/en/search", "/admin"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain(attack);
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;/script&gt;");
      expect(html).toContain("\\u003c/script\\u003e");
      const parsed =
        path === "/admin"
          ? readInert(html, "site-settings")
          : readReader(html).settings;
      expect(parseSiteSettingsValues(parsed)).toEqual(settings);
      expect(Object.keys(parsed as object).sort()).toEqual([
        "accent",
        "defaultLanguage",
        "locales",
        "logo",
        "theme",
      ]);
      expect(html).not.toContain("csrfToken");
      expect(html).not.toContain("authVersion");
    }
  });

  it("reads settings once per rendered reader or administrator document", async () => {
    let reads = 0;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.includes("FROM site_settings s")) reads++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (const [handler, path] of [
      [renderReader, "/en/home"],
      [adminShell, "/admin"],
    ] as const) {
      reads = 0;
      const response = await handler(
        new Request(`https://example.com${path}`),
        { ...env, DB: db },
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(reads).toBe(1);
    }
  });

  it("fails closed for missing, malformed or unavailable settings with no seed branding fallback", async () => {
    for (const failure of [
      null,
      {
        id: 1,
        version: 1,
        updated_at: "2026-09-23T00:00:00.000Z",
        theme: "invalid",
      },
      "throw",
    ] as const) {
      const db = new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (sql.includes("FROM site_settings s"))
                return {
                  first() {
                    if (failure === "throw")
                      throw new Error("Private storage details");
                    return Promise.resolve(failure);
                  },
                };
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      for (const method of ["GET", "HEAD"])
        for (const [handler, path] of [
          [renderReader, "/"],
          [adminShell, "/admin"],
          [publicSearch, "/api/public/search?q=Markdown"],
        ] as const) {
          const response = await handler(
            new Request(`https://example.com${path}`, { method }),
            { ...env, DB: db },
          );
          expect(response.status).toBe(503);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
          const body = await response.text();
          expect(body).not.toMatch(/Emby|Private|site-settings|reader-data/);
          if (method === "HEAD") expect(body).toBe("");
        }
    }
  });
});

describe("site theme precedence", () => {
  it("prefers a fixed visitor choice, then site choice, then system when configured", () => {
    for (const site of ["system", "light", "dark"] as const)
      for (const systemDark of [false, true]) {
        expect(effectiveTheme(site, "light", systemDark)).toBe("light");
        expect(effectiveTheme(site, "dark", systemDark)).toBe("dark");
        for (const saved of [null, "system", "invalid", {}])
          expect(effectiveTheme(site, saved, systemDark)).toBe(
            site === "system" ? (systemDark ? "dark" : "light") : site,
          );
      }
  });
});
