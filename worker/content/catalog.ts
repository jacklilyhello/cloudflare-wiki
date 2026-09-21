import type { Nodes } from "mdast";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import homeEn from "../../content/home.en.md?raw";
import homeZh from "../../content/home.zh.md?raw";
import markdownEn from "../../content/markdown.en.md?raw";
import markdownZh from "../../content/markdown.zh.md?raw";
import readingEn from "../../content/reading.en.md?raw";
import readingZh from "../../content/reading.zh.md?raw";
import type { Language } from "../../shared/contracts";
import type {
  NavigationEntry,
  SearchResult,
  WikiPage,
} from "../../shared/reader";

// Original starter documentation. Replace this repository with published D1
// revisions when persistence lands; no draft data belongs in the public catalog.
const articles = [
  [
    "home",
    "Emby 技术文档",
    "Emby documentation",
    "从清晰的文档开始，构建自己的媒体体验。",
    "Clear documentation for your media experience.",
    homeZh,
    homeEn,
    { zh: ["Emby", "入门"], en: ["Emby", "getting started"] },
  ],
  [
    "guide/reading",
    "阅读指南",
    "Reading guide",
    "快速找到内容，用你习惯的方式阅读。",
    "Find what you need and read your way.",
    readingZh,
    readingEn,
    { zh: ["指南", "导航", "搜索"], en: ["guide", "navigation", "search"] },
  ],
  [
    "guide/markdown",
    "Markdown 格式参考",
    "Markdown reference",
    "代码、表格、公式与图表，让技术说明更清晰。",
    "Code, tables, mathematics, and diagrams for clear technical writing.",
    markdownZh,
    markdownEn,
    {
      zh: ["Markdown", "格式", "代码", "语法"],
      en: ["Markdown", "format", "code", "syntax"],
    },
  ],
] as const;

export const publishedPages: WikiPage[] = articles.flatMap(
  ([path, zhTitle, enTitle, zhDescription, enDescription, zh, en, tags]) =>
    (["zh", "en"] as const).map((language) => ({
      id: `${path}:${language}`,
      translationId: path,
      language,
      path,
      title: language === "zh" ? zhTitle : enTitle,
      description: language === "zh" ? zhDescription : enDescription,
      markdown: language === "zh" ? zh : en,
      tags: [...tags[language]],
      updatedAt: "2026-09-21T00:00:00.000Z",
    })),
);

export function getPage(language: Language, path: string) {
  return (
    publishedPages.find(
      (page) => page.language === language && page.path === path,
    ) ?? null
  );
}

export function getTranslations(page: WikiPage | null) {
  return Object.fromEntries(
    publishedPages
      .filter((entry) => entry.translationId === page?.translationId)
      .map((entry) => [entry.language, `/${entry.language}/${entry.path}`]),
  );
}

export function getNavigation(language: Language): NavigationEntry[] {
  const home = getPage(language, "home");
  return [
    { title: home?.title ?? "Emby Wiki", path: `/${language}/home` },
    {
      title: language === "zh" ? "使用指南" : "Guides",
      children: publishedPages
        .filter(
          (page) =>
            page.language === language && page.path.startsWith("guide/"),
        )
        .map((page) => ({
          title: page.title,
          path: `/${language}/${page.path}`,
        })),
    },
  ];
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

const excerptParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkDirective);
function readableText(node: Nodes): string {
  if (node.type === "html") return "";
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node) return node.children.map(readableText).join(" ");
  if ("value" in node)
    return node.value.replace(
      /\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g,
      (_match, path: string, label?: string) => label ?? path,
    );
  return "";
}
const excerpts = new Map(
  publishedPages.map((page) => [
    page.id,
    readableText(excerptParser.parse(page.markdown))
      .replace(/\s+/gu, " ")
      .trim(),
  ]),
);

export function searchPages(language: Language, query: string): SearchResult[] {
  const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return [];
  return publishedPages
    .filter((page) => page.language === language)
    .map((page) => {
      const fields = [
        page.title,
        page.tags.join(" "),
        page.description,
        page.path,
        page.markdown,
      ].map(normalize);
      const score = tokens.reduce((total, token) => {
        const field = fields.findIndex((value) => value.includes(token));
        return field < 0 ? total : total + ([12, 8, 6, 4, 1][field] ?? 0);
      }, 0);
      const matches = tokens.every((token) =>
        fields.some((value) => value.includes(token)),
      );
      const body = excerpts.get(page.id) ?? page.description;
      const matchIndex = Math.max(0, normalize(body).indexOf(tokens[0] ?? ""));
      const start = Math.max(0, matchIndex - 40);
      return {
        page,
        score: matches ? score : 0,
        excerpt: `${start ? "…" : ""}${body.slice(start, start + 190)}${body.length > start + 190 ? "…" : ""}`,
      };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .slice(0, 30)
    .map(({ page, excerpt }) => ({
      title: page.title,
      description: page.description,
      path: `/${language}/${page.path}`,
      excerpt,
      tags: page.tags,
    }));
}
