import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import {
  BRAND_ROLES,
  type Branding,
  parseBranding,
  publicOrigin,
} from "../shared/branding";
import type { ReaderData } from "../shared/reader";
import { adminShell } from "../worker/admin";
import { renderReader, sitemap } from "../worker/reader";
import { contentFixture } from "./content-fixture";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  await contentFixture(env.DB);
});
function fixture(): Branding {
  const branding: Branding = {
    version: 1,
    assets: {},
    locales: {
      zh: {
        name: "配置名称",
        footer: '中文 <img src=x onerror="alert(1)">',
        copyright: "© 中文版权",
      },
      en: { footer: "English footer", copyright: "© English copyright" },
    },
  };
  for (const [index, role] of BRAND_ROLES.entries()) {
    const sha256 = String(index + 1).repeat(64);
    const [width, height] =
      role === "favicon"
        ? [32, 32]
        : role === "appleTouch"
          ? [180, 180]
          : role === "ogImage"
            ? [1200, 630]
            : [120, 48];
    branding.assets[role] = {
      path: `/assets/branding/${role}-${sha256}.png`,
      sha256,
      bytes: 100,
      mime: "image/png",
      width: width ?? 1,
      height: height ?? 1,
    };
  }
  return branding;
}
function bound(branding: Branding): Env {
  return {
    ...env,
    BRANDING_JSON: JSON.stringify(branding),
    ASSETS: {
      fetch: async () =>
        new Response(
          '<html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>fixture</title></head><body><div id="root"></div></body></html>',
          { headers: { "Content-Type": "text/html" } },
        ),
    },
  } as unknown as Env;
}
function data(html: string): ReaderData {
  return JSON.parse(
    /<script id="reader-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1] ?? "null",
  ) as ReaderData;
}
it("renders light/dark logo sources, same-origin icon tags, absolute OG metadata and escaped bilingual footer", async () => {
  const branding = fixture();
  const configured = bound(branding);
  const before = (await env.DB.prepare("SELECT * FROM site_settings").all())
    .results;
  for (const language of ["zh", "en"] as const) {
    const response = await renderReader(
      new Request(`https://untrusted-host.example/${language}/home`),
      configured,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Content-Security-Policy")).not.toMatch(
      /unsafe-inline|unsafe-eval|external/,
    );
    const html = await response.text();
    const reader = data(html);
    expect(reader.branding).toEqual(branding);
    expect(reader.settings.locales.zh.name).toBe("配置名称");
    expect(reader.settings.locales.en.name).toBe("Emby Wiki");
    expect(html).toContain('class="brand-logo-light"');
    expect(html).toContain('class="brand-logo-dark"');
    expect(html).toContain(`src="${branding.assets.logoLight?.path}"`);
    expect(html).toContain(`src="${branding.assets.logoDark?.path}"`);
    expect(html).toContain(
      `<link rel="icon" type="image/png" sizes="32x32" href="${branding.assets.favicon?.path}">`,
    );
    expect(html).not.toContain('href="/favicon.svg"');
    expect(html).toContain(
      `<link rel="apple-touch-icon" type="image/png" sizes="180x180" href="${branding.assets.appleTouch?.path}">`,
    );
    expect(html).toContain(
      `<meta property="og:image" content="https://cf.emby.wiki${branding.assets.ogImage?.path}">`,
    );
    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
    expect(html).not.toContain("https://untrusted-host.example");
    expect(html).toContain(
      language === "zh" ? "中文 &lt;img" : "English footer",
    );
    expect(html).toContain(branding.locales[language]?.copyright);
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).not.toContain("data:image/");
  }
  const shell = await adminShell(
    new Request("https://cf.emby.wiki/admin/settings"),
    configured,
  );
  const html = await shell.text();
  expect(html).toContain('id="deployment-branding"');
  expect(html).toContain("\\u003cimg");
  expect(html).not.toContain("<img src=x onerror=");
  expect(html).toContain('sizes="180x180"');
  expect(
    (await env.DB.prepare("SELECT * FROM site_settings").all()).results,
  ).toEqual(before);
});
it("missing configuration retains defaults, one logo serves both themes and empty footer is explicit", async () => {
  const branding: Branding = {
    version: 1,
    assets: { logoDark: fixture().assets.logoDark },
    locales: { zh: { footer: "" } },
  };
  const html = await (
    await renderReader(
      new Request("https://cf.emby.wiki/zh/home"),
      bound(branding),
    )
  ).text();
  expect(
    html.match(new RegExp(`src="${branding.assets.logoDark?.path}"`, "g"))
      ?.length,
  ).toBe(2);
  expect(html).toContain(
    '<footer class="site-footer"><span>Emby Wiki</span><span></span></footer>',
  );
  const fallback = await (
    await renderReader(new Request("https://cf.emby.wiki/en/home"), {
      ...bound(branding),
      BRANDING_JSON: "{}",
    } as Env)
  ).text();
  expect(fallback).toContain('<svg class="site-mark"');
  expect(fallback).toContain('href="/favicon.svg"');
  expect(fallback).not.toContain('property="og:image"');
  expect(fallback).toContain("Emby Wiki documentation");
});
it("future production origin is selected by validated configuration and corrupt config fails closed", async () => {
  const branding = fixture();
  const production = {
    ...bound(branding),
    APP_ENV: "production",
    PUBLIC_ORIGIN: "https://emby.wiki",
  } as unknown as Env;
  const html = await (
    await renderReader(
      new Request("https://malicious.example/en/home"),
      production,
    )
  ).text();
  expect(html).toContain(
    `<meta property="og:image" content="https://emby.wiki${branding.assets.ogImage?.path}">`,
  );
  expect(
    await (
      await sitemap(
        new Request("https://malicious.example/sitemap.xml"),
        production,
      )
    ).text(),
  ).toContain("https://emby.wiki/en/home");
  expect(publicOrigin({ APP_ENV: "test" })).toBe("https://cf.emby.wiki");
  for (const value of [
    '{"version":2}',
    JSON.stringify({
      ...branding,
      assets: {
        logoLight: {
          ...branding.assets.logoLight,
          path: "//external/logo.png",
        },
      },
    }),
    JSON.stringify({
      ...branding,
      locales: { fr: { footer: "not supported" } },
    }),
  ]) {
    expect(() => parseBranding(value)).toThrow();
    expect(
      (
        await renderReader(new Request("https://cf.emby.wiki/zh/home"), {
          ...bound(branding),
          BRANDING_JSON: value,
        } as unknown as Env)
      ).status,
    ).toBe(503);
  }
  expect(
    (
      await renderReader(new Request("https://cf.emby.wiki/zh/home"), {
        ...bound(branding),
        PUBLIC_ORIGIN: "https://emby.wiki",
      } as unknown as Env)
    ).status,
  ).toBe(503);
});
