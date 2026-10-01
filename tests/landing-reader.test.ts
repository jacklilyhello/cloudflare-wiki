import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import type { Branding } from "../shared/branding";
import type { ReaderData } from "../shared/reader";
import { INITIAL_SITE_SETTINGS } from "../shared/settings";
import { renderReader } from "../worker/reader";
import { SettingsService } from "../worker/settings/service";
import { contentFixture } from "./content-fixture";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
});

function readData(html: string): ReaderData {
  return JSON.parse(
    /<script id="reader-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1] ?? "null",
  );
}

it.each(["/", "/?lang=zh", "/?lang=en"])(
  "serves an independent SSR cover at %s with working reading links and root metadata",
  async (path) => {
    const response = await exports.default.fetch(
      `https://untrusted.example${path}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Content-Security-Policy")).not.toMatch(
      /unsafe-inline|unsafe-eval/,
    );
    const html = await response.text();
    const data = readData(html);
    const language = path.endsWith("en") ? "en" : "zh";
    expect(data).toMatchObject({
      mode: "landing",
      language,
      page: null,
      rendered: null,
      navigation: [],
      searchQuery: "",
      searchResults: [],
      translations: { zh: "/?lang=zh", en: "/?lang=en" },
    });
    expect(html).toContain(`lang="${language}"`);
    expect(html).toContain('data-document="landing"');
    expect(html).toContain('<main id="cover-content"');
    expect(html).toContain('id="cover-title"');
    expect(html).toContain(`href="/${language}/home"`);
    expect(html).toContain('href="/?lang=zh"');
    expect(html).toContain('href="/?lang=en"');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(
      '<meta property="og:url" content="https://cf.emby.wiki/">',
    );
    expect(html).toContain(
      '<link rel="canonical" href="https://cf.emby.wiki/">',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://cf.emby.wiki/">',
    );
    expect(html).toContain(
      `<meta property="og:locale" content="${language === "zh" ? "zh_CN" : "en_US"}">`,
    );
    expect(html).not.toMatch(
      /<article\b|desktop-navigation|untrusted\.example|测试环境|Test environment/,
    );
    expect(html.indexOf('name="theme-color"')).toBeLessThan(
      html.indexOf('<script src="/assets/site-appearance.js"'),
    );
    expect(
      html.indexOf('<script src="/assets/site-appearance.js"'),
    ).toBeLessThan(html.indexOf("<title>"));
    const head = await exports.default.fetch(
      `https://untrusted.example${path}`,
      { method: "HEAD" },
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  },
);

it("only reads presentation settings, even when the home publication is unavailable, with no content or navigation writes", async () => {
  const { service } = await contentFixture(env.DB);
  const home = await service.getAdminTranslation("starter-home-zh");
  await service.unpublish(home.id, home.version);
  const queries: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          queries.push(sql);
          if (!/^\s*SELECT\b/i.test(sql))
            throw new Error("Cover attempted a write");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await renderReader(new Request("https://cf.emby.wiki/"), {
    ...env,
    DB: db,
  });
  expect(response.status).toBe(200);
  expect(readData(await response.text()).mode).toBe("landing");
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("FROM site_settings s");
});

it("respects default English and deployment branding without persisting either to D1", async () => {
  const { access } = await contentFixture(env.DB);
  const service = new SettingsService(env.DB, access);
  const current = await service.get();
  await service.update({
    ...INITIAL_SITE_SETTINGS,
    defaultLanguage: "en",
    theme: "dark",
    expectedVersion: current.version,
  });
  const branding: Branding = {
    version: 1,
    assets: {
      logoLight: {
        path: `/assets/branding/logoLight-${"a".repeat(64)}.png`,
        sha256: "a".repeat(64),
        bytes: 100,
        mime: "image/png",
        width: 256,
        height: 256,
      },
    },
    locales: {
      zh: { name: "emby.wiki", description: "中文品牌描述" },
      en: {
        name: "emby.wiki",
        description: "English brand description",
        copyright: "© emby.wiki",
      },
    },
  };
  const before = (await env.DB.prepare("SELECT * FROM site_settings").all())
    .results;
  const html = await (
    await renderReader(new Request("https://cf.emby.wiki/"), {
      ...env,
      BRANDING_JSON: JSON.stringify(branding),
    } as unknown as Env)
  ).text();
  expect(readData(html).language).toBe("en");
  expect(html).toContain("<title>emby.wiki · The Emby Handbook</title>");
  expect(html).toContain(
    '<meta name="description" content="English brand description">',
  );
  expect(html).toContain('data-theme="dark"');
  expect(html).toContain('name="theme-color" content="#091410"');
  expect(html).toContain(`src="${branding.assets.logoLight?.path}"`);
  expect(html).toContain('class="brand-logo-dark"');
  expect(html).toContain('href="/en/home"');
  expect(html).toContain("© emby.wiki");
  expect(
    (await env.DB.prepare("SELECT * FROM site_settings").all()).results,
  ).toEqual(before);
});

it("escapes branding text and inert payloads, ignores unsupported language choices and rejects root writes", async () => {
  const attack = '</script><img src=x onerror="alert(1)">&';
  const html = await (
    await renderReader(new Request("https://cf.emby.wiki/?lang=fr"), {
      ...env,
      BRANDING_JSON: JSON.stringify({
        version: 1,
        assets: {},
        locales: { zh: { name: attack, description: attack } },
      }),
    } as unknown as Env)
  ).text();
  expect(readData(html).language).toBe("zh");
  expect(html).not.toContain(attack);
  expect(html).toContain("&lt;/script&gt;");
  expect(html).toContain("\\u003c/script\\u003e");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await exports.default.fetch("https://cf.emby.wiki/", {
      method,
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  }
});
