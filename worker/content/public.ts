import type { Language } from "../../shared/contracts";
import { publicPath } from "../../shared/paths";
import type {
  NavigationEntry,
  SearchResult,
  WikiPage,
} from "../../shared/reader";
import { compileSearchQuery } from "../../shared/search";

interface PublishedRow {
  id: string;
  page_id: string;
  language: Language;
  slug: string;
  title: string;
  description: string;
  markdown: string;
  tags_json: string;
  updated_at: string;
}

interface SearchRow {
  title: string;
  description: string;
  slug: string;
  tags_json: string;
  body_text: string;
}

function tagsFromJson(value: string): string[] {
  const tags: unknown = JSON.parse(value);
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string");
}

function toPage(row: PublishedRow): WikiPage {
  return {
    id: row.id,
    // The reader's translationId identifies the stable bilingual page group.
    translationId: row.page_id,
    language: row.language,
    path: row.slug,
    title: row.title,
    description: row.description,
    markdown: row.markdown,
    tags: tagsFromJson(row.tags_json),
    updatedAt: row.updated_at,
  };
}

// Every public read joins the current publication pointer to a revision owned
// by the same translation. Draft pointers and mutable draft timestamps are never
// selected. Historical routes only resolve while their translation is public.
export async function getPage(
  db: D1Database,
  language: Language,
  path: string,
): Promise<WikiPage | null> {
  const row = await db
    .prepare(`
    SELECT t.id, t.page_id, t.language, t.slug,
           r.title, r.description, r.markdown, r.tags_json,
           t.published_at AS updated_at
    FROM page_routes AS route
    JOIN page_translations AS t
      ON t.id = route.translation_id AND t.language = route.language
    JOIN page_revisions AS r
      ON r.id = t.published_revision_id AND r.translation_id = t.id
    WHERE route.language = ? AND route.path = ? AND t.deleted_at IS NULL
  `)
    .bind(language, path)
    .first<PublishedRow>();
  return row ? toPage(row) : null;
}

export async function getTranslations(
  db: D1Database,
  page: WikiPage | null,
): Promise<Partial<Record<Language, string>>> {
  if (!page) return {};
  const rows = await db
    .prepare(`
    SELECT t.language, t.slug
    FROM page_translations AS t
    JOIN page_revisions AS r
      ON r.id = t.published_revision_id AND r.translation_id = t.id
    WHERE t.page_id = ? AND t.deleted_at IS NULL
    ORDER BY t.language
  `)
    .bind(page.translationId)
    .all<{ language: Language; slug: string }>();
  return Object.fromEntries(
    rows.results.map((row) => [
      row.language,
      publicPath(row.language, row.slug),
    ]),
  );
}

function folderLabel(segment: string, language: Language): string {
  if (segment === "guide") return language === "zh" ? "使用指南" : "Guides";
  const label = segment.replace(/[-_]/g, " ");
  return language === "en"
    ? label.charAt(0).toUpperCase() + label.slice(1)
    : label;
}

export async function getNavigation(
  db: D1Database,
  language: Language,
): Promise<NavigationEntry[]> {
  const rows = await db
    .prepare(`
    SELECT t.slug, r.title
    FROM page_translations AS t
    JOIN page_revisions AS r
      ON r.id = t.published_revision_id AND r.translation_id = t.id
    WHERE t.language = ? AND t.deleted_at IS NULL
    ORDER BY CASE WHEN t.slug = 'home' THEN 0 ELSE 1 END, t.slug
  `)
    .bind(language)
    .all<{ slug: string; title: string }>();
  const roots: NavigationEntry[] = [];
  const entries = new Map<string, NavigationEntry>();
  for (const row of rows.results) {
    const segments = row.slug.split("/");
    let children = roots;
    for (let depth = 0; depth < segments.length; depth++) {
      const path = segments.slice(0, depth + 1).join("/");
      const leaf = depth === segments.length - 1;
      let entry = entries.get(path);
      if (!entry) {
        entry = { title: folderLabel(segments[depth] ?? "", language) };
        entries.set(path, entry);
        children.push(entry);
      }
      if (leaf) {
        entry.title = row.title;
        entry.path = publicPath(language, row.slug);
      } else {
        entry.children ??= [];
        children = entry.children;
      }
    }
  }
  return roots;
}

export async function getPublishedPages(db: D1Database) {
  const rows = await db
    .prepare(`
    SELECT t.language, t.slug AS path, t.published_at AS updatedAt
    FROM page_translations AS t
    JOIN page_revisions AS r
      ON r.id = t.published_revision_id AND r.translation_id = t.id
    WHERE t.deleted_at IS NULL
    ORDER BY t.language, t.slug
  `)
    .all<{ language: Language; path: string; updatedAt: string }>();
  return rows.results;
}

function excerpt(body: string, query: string): string {
  const terms =
    query
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const lowerBody = body.toLocaleLowerCase("en-US");
  const positions = terms
    .map((term) => lowerBody.indexOf(term))
    .filter((index) => index >= 0);
  const start = Math.max(
    0,
    (positions.length ? Math.min(...positions) : 0) - 40,
  );
  return `${start ? "…" : ""}${body.slice(start, start + 190)}${body.length > start + 190 ? "…" : ""}`;
}

export async function searchPages(
  db: D1Database,
  language: Language,
  query: string,
): Promise<SearchResult[]> {
  const match = compileSearchQuery(query);
  if (!match) return [];
  const rows = await db
    .prepare(`
    SELECT s.title, s.description, t.slug, s.tags_json, s.body_text
    FROM published_search_fts AS f
    JOIN published_search AS s
      ON s.rowid = f.rowid
      AND s.translation_id = f.translation_id AND s.language = f.language
    JOIN page_translations AS t
      ON t.id = s.translation_id AND t.language = s.language
      AND t.published_revision_id = s.revision_id AND t.slug = s.path
    JOIN page_revisions AS r
      ON r.id = t.published_revision_id AND r.translation_id = t.id
    WHERE published_search_fts MATCH ? AND t.language = ? AND t.deleted_at IS NULL
    ORDER BY bm25(published_search_fts, 0, 0, 12, 8, 6, 4, 1), t.slug
    LIMIT 30
  `)
    .bind(match, language)
    .all<SearchRow>();
  return rows.results.map((row) => ({
    title: row.title,
    description: row.description,
    path: publicPath(language, row.slug),
    excerpt: excerpt(row.body_text, query),
    tags: tagsFromJson(row.tags_json),
  }));
}
