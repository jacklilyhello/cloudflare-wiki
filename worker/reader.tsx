import { renderToString } from "react-dom/server";
import type { Language } from "../shared/contracts";
import { renderMarkdown } from "../shared/markdown";
import { publicPath } from "../shared/paths";
import type { ReaderData } from "../shared/reader";
import { App } from "../src/App";
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
  securityHeaders,
} from "./security";

const canonicalOrigin = "https://cf.emby.wiki";

function isLanguage(value: string | undefined): value is Language {
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
  const language = url.searchParams.get("lang") ?? "zh";
  const query = url.searchParams.get("q") ?? "";
  if (!isLanguage(language)) return jsonError("Unsupported language", 400);
  if (query.length > 200) return jsonError("Search query is too long", 400);
  try {
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
          ...securityHeaders,
          "Content-Type": "application/xml; charset=utf-8",
        },
      },
    );
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
  const segments = url.pathname.split("/").filter(Boolean);
  const language = isLanguage(segments[0]) ? segments[0] : "zh";
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
  const [page, navigation, searchResults] = await Promise.all([
    !search && validLanguage ? getPage(env.DB, language, path) : null,
    getNavigation(env.DB, language),
    search ? searchPages(env.DB, language, query) : [],
  ]);
  if (page && page.path !== path) {
    return new Response(null, {
      status: 301,
      headers: {
        ...securityHeaders,
        Location: publicPath(page.language, page.path),
      },
    });
  }
  const data: ReaderData = {
    language,
    page,
    rendered: page ? await renderMarkdown(page.markdown, language) : null,
    navigation,
    translations: search
      ? {
          zh: `/zh/search?q=${encodeURIComponent(query)}`,
          en: `/en/search?q=${encodeURIComponent(query)}`,
        }
      : await getTranslations(env.DB, page),
    mode: search ? "search" : page ? "article" : "not-found",
    searchQuery: search ? query : "",
    searchResults,
  };
  const status = data.mode === "not-found" ? 404 : 200;
  const title =
    page?.title ??
    (search
      ? language === "zh"
        ? "搜索文档"
        : "Search documentation"
      : language === "zh"
        ? "找不到页面"
        : "Page not found");
  const description =
    page?.description ??
    (language === "zh" ? "Emby Wiki 技术文档" : "Emby Wiki documentation");
  const canonical =
    canonicalOrigin +
    publicPath(language, page?.path ?? (search ? "search" : "home"));
  const alternateLinks = Object.entries(data.translations)
    .map(
      ([lang, path]) =>
        `<link rel="alternate" hreflang="${lang}" href="${escapeHtml(canonicalOrigin + path)}">`,
    )
    .join("");
  const metadata = `<meta name="description" content="${escapeHtml(description)}"><meta property="og:title" content="${escapeHtml(title)} · Emby Wiki"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="article"><meta property="og:site_name" content="Emby Wiki"><meta property="og:url" content="${escapeHtml(canonical)}">${page ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ""}${alternateLinks}`;
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
    .on("html", {
      element(element) {
        element.setAttribute("lang", language);
      },
    })
    .on("title", {
      element(element) {
        element.setInnerContent(`${title} · Emby Wiki`);
      },
    })
    .on("head", {
      element(element) {
        element.append(metadata, { html: true });
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
    headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}
