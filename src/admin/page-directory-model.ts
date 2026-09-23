import { CONTENT_LIMITS, type PageSummary } from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { DIRECTORY_LIMITS, type PageDirectory } from "../../shared/directories";
import { isContentPath } from "../../shared/page-path";

export class PageDirectoryChanged extends Error {}

export interface DirectoryScope {
  language: Language;
  path: string;
}
export interface DirectoryRead {
  cursor: string | null;
  previous: (string | null)[];
  version?: number;
  after?: string;
}
export interface DirectoryView {
  page: PageDirectory;
  read: DirectoryRead;
}

export function firstDirectoryRead(): DirectoryRead {
  return { cursor: null, previous: [] };
}

function changed(): never {
  throw new PageDirectoryChanged();
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) changed();
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length ||
    fields.some((key) => !keys.includes(key))
  )
    changed();
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  );
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function cursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= DIRECTORY_LIMITS.cursor &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
function scope(value: DirectoryScope) {
  if (
    (value.language !== "zh" && value.language !== "en") ||
    (value.path !== "" && !isContentPath(value.path))
  )
    changed();
}

function pageSummary(value: unknown, expected: DirectoryScope): PageSummary {
  const page = record(value, [
    "id",
    "pageId",
    "language",
    "path",
    "version",
    "revisionSeq",
    "draftRevisionId",
    "publishedRevisionId",
    "createdAt",
    "updatedAt",
    "publishedAt",
    "deletedAt",
    "title",
    "description",
    "tags",
  ]);
  if (
    !identifier(page.id) ||
    !identifier(page.pageId) ||
    page.language !== expected.language ||
    page.path !== expected.path ||
    !isContentPath(page.path) ||
    !positive(page.version) ||
    !positive(page.revisionSeq) ||
    !identifier(page.draftRevisionId) ||
    (page.publishedRevisionId !== null &&
      !identifier(page.publishedRevisionId)) ||
    !timestamp(page.createdAt) ||
    !timestamp(page.updatedAt) ||
    (page.publishedAt !== null && !timestamp(page.publishedAt)) ||
    (page.publishedRevisionId === null) !== (page.publishedAt === null) ||
    page.deletedAt !== null ||
    typeof page.title !== "string" ||
    !page.title.trim() ||
    page.title.length > CONTENT_LIMITS.title ||
    typeof page.description !== "string" ||
    page.description.length > CONTENT_LIMITS.description ||
    !Array.isArray(page.tags) ||
    page.tags.length > CONTENT_LIMITS.tags ||
    page.tags.some(
      (tag) => typeof tag !== "string" || tag.length > CONTENT_LIMITS.tag,
    )
  )
    changed();
  return page as unknown as PageSummary;
}

// SQLite's BINARY ordering follows Unicode scalar order. JavaScript's ordinary
// string comparison sorts surrogate pairs differently from BMP characters.
function compareSegments(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference =
      (a[i]?.codePointAt(0) ?? 0) - (b[i]?.codePointAt(0) ?? 0);
    if (difference) return difference;
  }
  return a.length - b.length;
}

export function directoryQuery(
  expected: DirectoryScope,
  read = firstDirectoryRead(),
): string {
  scope(expected);
  if (read.cursor !== null && !cursor(read.cursor)) changed();
  const query = new URLSearchParams({
    path: expected.path,
    limit: String(DIRECTORY_LIMITS.defaultPage),
  });
  if (read.cursor) query.set("cursor", read.cursor);
  return `directories/${expected.language}?${query}`;
}

export function directoryBreadcrumbs(
  path: string,
): { segment: string; path: string }[] {
  if (path === "") return [];
  if (!isContentPath(path)) changed();
  let current = "";
  return path.split("/").map((segment) => {
    current = current ? `${current}/${segment}` : segment;
    return { segment, path: current };
  });
}

export function readDirectoryPage(
  value: unknown,
  expected: DirectoryScope,
  read = firstDirectoryRead(),
): DirectoryView {
  scope(expected);
  const page = record(value, [
    "language",
    "path",
    "version",
    "page",
    "items",
    "nextCursor",
  ]);
  if (
    page.language !== expected.language ||
    page.path !== expected.path ||
    !positive(page.version) ||
    (read.version !== undefined && page.version !== read.version) ||
    !Array.isArray(page.items) ||
    page.items.length > DIRECTORY_LIMITS.defaultPage ||
    (page.nextCursor !== null && !cursor(page.nextCursor)) ||
    (page.nextCursor !== null &&
      (page.nextCursor === read.cursor ||
        read.previous.includes(page.nextCursor as string)))
  )
    changed();
  const ids = new Set<string>();
  if (page.page !== null) {
    if (!expected.path) changed();
    ids.add(pageSummary(page.page, expected).id);
  }
  let previous = read.after;
  for (const value of page.items) {
    const item = record(value, ["path", "segment", "page", "hasChildren"]);
    if (
      typeof item.segment !== "string" ||
      !item.segment ||
      item.segment.includes("/") ||
      !isContentPath(item.path) ||
      item.path !==
        (expected.path ? `${expected.path}/${item.segment}` : item.segment) ||
      typeof item.hasChildren !== "boolean" ||
      (item.page === null && !item.hasChildren) ||
      (previous !== undefined && compareSegments(previous, item.segment) >= 0)
    )
      changed();
    previous = item.segment;
    if (item.page !== null) {
      const summary = pageSummary(item.page, {
        language: expected.language,
        path: item.path,
      });
      if (ids.has(summary.id)) changed();
      ids.add(summary.id);
    }
  }
  if (
    (page.nextCursor !== null &&
      page.items.length !== DIRECTORY_LIMITS.defaultPage) ||
    (read.after !== undefined && page.items.length === 0) ||
    (expected.path &&
      page.page === null &&
      page.items.length === 0 &&
      read.cursor === null)
  )
    changed();
  return {
    page: page as unknown as PageDirectory,
    read: { ...read, previous: [...read.previous] },
  };
}

export function adjacentDirectoryRead(
  view: DirectoryView,
  direction: "next" | "previous",
): DirectoryRead | null {
  if (direction === "next") {
    if (!view.page.nextCursor) return null;
    return {
      cursor: view.page.nextCursor,
      previous: [...view.read.previous, view.read.cursor],
      version: view.page.version,
      after: view.page.items.at(-1)?.segment,
    };
  }
  if (!view.read.previous.length) return null;
  const previous = [...view.read.previous];
  return {
    cursor: previous.pop() ?? null,
    previous,
    version: view.page.version,
  };
}
