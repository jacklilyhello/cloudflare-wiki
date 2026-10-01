import { renderToString } from "react-dom/server";
import { brandSettings, parseBranding, publicOrigin } from "../shared/branding";
import type { Language } from "../shared/contracts";
import { renderMarkdown } from "../shared/markdown";
import { publicPath } from "../shared/paths";
import type { ReaderData } from "../shared/reader";
import { App } from "../src/App";
import { brandIcons, brandOpenGraph } from "./branding";
import {
  getNavigation,
  getPage,
  getPublishedPages,
  getTranslations,
  searchPages,
} from "./content/public";
import {
  escapeHtml,
  jsonError,
  methodNotAllowed,
  publicSecurityHeaders,
  securityHeaders,
} from "./security";
import { getSiteSettings } from "./settings/service";

function isLanguage(value: string | null | undefined): value is Language {
  return value === "zh" || value === "en";
}

function contentUnavailable(request: Request) {
  return new Response(
    request.method === "HEAD"
      ? null
      : JSON.stringify({ error: "Content temporarily unavailable" }),
    {
      status: 503,
      headers: {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}

export async function publicSearch(request: Request, env: Env) {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  const url = new URL(request.url);
  const requestedLanguage = url.searchParams.get("lang");
  const query = url.searchParams.get("q") ?? "";
  if (requestedLanguage !== null && !isLanguage(requestedLanguage))
    return jsonError("Unsupported language", 400);
  if (query.length > 200) return jsonError("Search query is too long", 400);
  try {
    const language =
      requestedLanguage ?? (await getSiteSettings(env.DB)).defaultLanguage;
    const results = await searchPages(env.DB, language, query);
    return new Response(
      request.method === "HEAD" ? null : JSON.stringify({ results }),
      {
        headers: {
          ...securityHeaders,
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  } catch {
    return contentUnavailable(request);
  }
}

export async function sitemap(request: Request, env: Env) {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  try {
    const pages = await getPublishedPages(env.DB);
    const canonicalOrigin = publicOrigin(env);
    const entries = pages
      .map(
        (page) =>
          `<url><loc>${escapeHtml(canonicalOrigin + publicPath(page.language, page.path))}</loc><lastmod>${escapeHtml(page.updatedAt.slice(0, 10))}</lastmod></url>`,
      )
      .join("");
    return new Response(
      request.method === "HEAD"
        ? null
        : `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
      {
        headers: {
          ...publicSecurityHeaders(env),
          "Content-Type": "application/xml; charset=utf-8",
        },
      },
    );
  } catch {
    return contentUnavailable(request);
  }
}

export function robots(request: Request, env: Env) {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  try {
    const origin = publicOrigin(env);
    const body =
      env.APP_ENV === "production"
        ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /health\nDisallow: /zh/search\nDisallow: /en/search\nSitemap: ${origin}/sitemap.xml\n`
        : "User-agent: *\nDisallow: /\n";
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        ...publicSecurityHeaders(env),
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  } catch {
    return contentUnavailable(request);
  }
}

export async function renderReader(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  try {
    return await renderReaderDocument(request, env);
  } catch {
    // Fail closed on unavailable storage or invalid stored content. Do not
    // expose database errors or silently serve an obsolete static publication.
    return contentUnavailable(request);
  }
}

async function renderReaderDocument(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const {
    version: _version,
    updatedAt: _updatedAt,
    ...storedSettings
  } = await getSiteSettings(env.DB);
  const branding = parseBranding(env.BRANDING_JSON);
  const settings = brandSettings(storedSettings, branding);
  const canonicalOrigin = publicOrigin(env);
  const landing = url.pathname === "/";
  const segments = url.pathname.split("/").filter(Boolean);
  const selectedLanguage = landing ? url.searchParams.get("lang") : segments[0];
  const language = isLanguage(selectedLanguage)
    ? selectedLanguage
    : settings.defaultLanguage;
  const identity = settings.locales[language];
  const validLanguage = url.pathname === "/" || isLanguage(segments[0]);
  let decodedSegments: string[];
  try {
    decodedSegments = segments.slice(1).map(decodeURIComponent);
  } catch {
    return jsonError("Invalid document path", 400);
  }
  if (
    decodedSegments.some(
      (segment) =>
        segment.includes("/") ||
        segment.includes("\\") ||
        [...segment].some((character) => character.charCodeAt(0) < 32),
    )
  ) {
    return jsonError("Invalid document path", 400);
  }
  const path = decodedSegments.join("/") || "home";
  const search = validLanguage && path === "search";
  const query = url.searchParams.get("q") ?? "";
  if (query.length > 200) return jsonError("Search query is too long", 400);
  // The cover needs only public presentation settings, never the content tree.
  const [page, navigation, searchResults] = await Promise.all([
    !landing && !search && validLanguage
      ? getPage(env.DB, language, path)
      : null,
    landing ? [] : getNavigation(env.DB, language),
    !landing && search ? searchPages(env.DB, language, query) : [],
  ]);
  if (page && page.path !== path) {
    return new Response(null, {
      status: 301,
      headers: {
        ...publicSecurityHeaders(env),
        Location: publicPath(page.language, page.path) + url.search,
      },
    });
  }
  const data: ReaderData = {
    branding,
    settings,
    language,
    page,
    rendered: page
      ? await renderMarkdown(page.markdown, language, page.linkBasePath)
      : null,
    navigation,
    translations: landing
      ? { zh: "/?lang=zh", en: "/?lang=en" }
      : search
        ? {
            zh: `/zh/search?q=${encodeURIComponent(query)}`,
            en: `/en/search?q=${encodeURIComponent(query)}`,
          }
        : await getTranslations(env.DB, page),
    mode: landing
      ? "landing"
      : search
        ? "search"
        : page
          ? "article"
          : "not-found",
    searchQuery: search ? query : "",
    searchResults,
  };
  const status = data.mode === "not-found" ? 404 : 200;
  const indexable = landing || data.mode === "article";
  const title = landing
    ? language === "zh"
      ? "Emby 技术手册"
      : "The Emby Handbook"
    : (page?.title ??
      (search
        ? language === "zh"
          ? "搜索文档"
          : "Search documentation"
        : language === "zh"
          ? "找不到页面"
          : "Page not found"));
  const description = page?.description || identity.description;
  const documentTitle = landing
    ? `${identity.name} · ${title}`
    : `${title} · ${identity.name}`;
  const canonical = landing
    ? `${canonicalOrigin}/`
    : canonicalOrigin +
      publicPath(language, page?.path ?? (search ? "search" : "home"));
  const alternateLinks = Object.entries(data.translations)
    .map(
      ([lang, path]) =>
        `<link rel="alternate" hreflang="${lang}" href="${escapeHtml(canonicalOrigin + path)}">`,
    )
    .join("");
  const themeColors = landing
    ? { light: "#f5f4ee", dark: "#091410" }
    : { light: "#ffffff", dark: "#151a18" };
  const themeMetadata = `<meta name="theme-color" content="${settings.theme === "dark" ? themeColors.dark : themeColors.light}" data-light="${themeColors.light}" data-dark="${themeColors.dark}">`;
  const metadata = `<meta name="description" content="${escapeHtml(description)}"><meta property="og:title" content="${escapeHtml(documentTitle)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="${landing ? "website" : "article"}"><meta property="og:site_name" content="${escapeHtml(identity.name)}"><meta property="og:url" content="${escapeHtml(canonical)}">${page || landing ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ""}${alternateLinks}${landing ? `<link rel="alternate" hreflang="x-default" href="${escapeHtml(canonical)}"><meta property="og:locale" content="${language === "zh" ? "zh_CN" : "en_US"}"><meta property="og:locale:alternate" content="${language === "zh" ? "en_US" : "zh_CN"}">` : ""}`;
  // Inert JSON cannot close its script element; no executable inline code or
  // user-provided HTML crosses this boundary except the sanitized renderer output.
  const serialized = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const templateRequest = new Request(new URL("/index.html", request.url), {
    method: "GET",
  });
  const template = await env.ASSETS.fetch(templateRequest);
  if (!template.ok) return jsonError("Reader assets unavailable", 503);
  const transformed = new HTMLRewriter()
    .on('meta[name="robots"]', {
      element(element) {
        if (env.APP_ENV === "production" && indexable) element.remove();
      },
    })
    .on("html", {
      element(element) {
        element.setAttribute("lang", language);
        element.setAttribute("data-theme", settings.theme);
        element.setAttribute("data-accent", settings.accent);
        if (landing) element.setAttribute("data-document", "landing");
      },
    })
    .on("title", {
      element(element) {
        element.setInnerContent(documentTitle);
      },
    })
    .on("head", {
      element(element) {
        element.prepend(
          `${themeMetadata}<script src="/assets/site-appearance.js"></script>`,
          { html: true },
        );
        element.append(
          metadata +
            brandIcons(branding) +
            brandOpenGraph(branding, canonicalOrigin, identity.name),
          { html: true },
        );
      },
    })
    .on('link[rel="icon"]', {
      element(element) {
        if (branding.assets.favicon) element.remove();
      },
    })
    .on("#root", {
      element(element) {
        element.setInnerContent(renderToString(<App data={data} />), {
          html: true,
        });
      },
    })
    .on("body", {
      element(element) {
        element.append(
          `<script id="reader-data" type="application/json">${serialized}</script>`,
          { html: true },
        );
      },
    })
    .transform(template);
  return new Response(request.method === "HEAD" ? null : transformed.body, {
    status,
    headers: {
      ...(indexable ? publicSecurityHeaders(env) : securityHeaders),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
