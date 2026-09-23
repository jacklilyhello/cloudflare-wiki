import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PageSummary } from "../shared/content";
import type { Language } from "../shared/contracts";
import {
  DIRECTORY_LIMITS,
  type PageDirectory,
  type PageDirectoryItem,
} from "../shared/directories";
import {
  adjacentDirectoryRead,
  directoryBreadcrumbs,
  directoryQuery,
  firstDirectoryRead,
  PageDirectoryChanged,
  readDirectoryPage,
} from "../src/admin/page-directory-model";
import { fixtureSessionToken, seedContentAccess } from "./content-fixture";

const scope = { language: "zh" as const, path: "guide" };
const timestamp = "2026-09-23T12:00:00.000Z";
let identity = 0;
function summary(path: string, language: Language = "zh"): PageSummary {
  const id = `fixture-${++identity}`;
  return {
    id,
    pageId: `page-${id}`,
    language,
    path,
    version: 2,
    revisionSeq: 1,
    draftRevisionId: `revision-${id}`,
    publishedRevisionId: null,
    publishedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    title: "测试页面",
    description: "A local directory fixture",
    tags: ["guide"],
  };
}
function node(segment: string, path = "guide"): PageDirectoryItem {
  const fullPath = path ? `${path}/${segment}` : segment;
  return {
    path: fullPath,
    segment,
    page: summary(fullPath),
    hasChildren: false,
  };
}
function page(
  items: PageDirectoryItem[],
  nextCursor: string | null = null,
): PageDirectory {
  return { ...scope, version: 7, page: null, items, nextCursor };
}
function chunk(start = 0) {
  return Array.from({ length: DIRECTORY_LIMITS.defaultPage }, (_, index) =>
    node(`page-${String(start + index).padStart(3, "0")}`),
  );
}

describe("page directory browser model", () => {
  it("accepts real bilingual directory responses from the protected HTTP API", async () => {
    await seedContentAccess(env.DB);
    for (const language of ["zh", "en"] as const) {
      for (const path of ["", "guide"]) {
        const expected = { language, path };
        const response = await exports.default.fetch(
          `https://example.com/api/admin/${directoryQuery(expected)}`,
          { headers: { Cookie: `__Host-wiki_session=${fixtureSessionToken}` } },
        );
        expect(response.status).toBe(200);
        const view = readDirectoryPage(await response.json(), expected);
        expect(view.page.items.length).toBeGreaterThan(0);
        expect(view.page.language).toBe(language);
        expect(view.page.path).toBe(path);
      }
    }
  });

  it("builds bounded language-specific reads and safely encodes Unicode prefixes", () => {
    const query = directoryQuery(
      { language: "en", path: "文档/安装" },
      { cursor: "cGFnZTI", previous: [null], version: 7 },
    );
    const url = new URL(query, "https://example.com");
    expect(url.pathname).toBe("/directories/en");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: "文档/安装",
      limit: "25",
      cursor: "cGFnZTI",
    });
    expect(
      new URL(
        directoryQuery({ language: "zh", path: "" }),
        "https://example.com",
      ).searchParams.get("path"),
    ).toBe("");
    for (const path of [
      "../bad",
      "Guide",
      "ｇｕｉｄｅ",
      "admin/private",
      "a//b",
      "a%2fb",
    ])
      expect(() => directoryQuery({ language: "zh", path })).toThrow(
        PageDirectoryChanged,
      );
    expect(() =>
      directoryQuery(scope, { cursor: "bad/cursor", previous: [] }),
    ).toThrow(PageDirectoryChanged);
  });

  it("derives deep Unicode breadcrumbs without network reads or a file-folder depth limit", () => {
    const segments = Array.from({ length: 14 }, (_, index) => `章节${index}`);
    const path = segments.join("/");
    const trail = directoryBreadcrumbs(path);
    expect(trail).toHaveLength(14);
    expect(trail[0]).toEqual({ segment: "章节0", path: "章节0" });
    expect(trail.at(-1)).toEqual({ segment: "章节13", path });
    expect(trail[8]?.path).toBe(segments.slice(0, 9).join("/"));
    expect(directoryBreadcrumbs("")).toEqual([]);
    expect(() => directoryBreadcrumbs(`${"文".repeat(239)}/字`)).toThrow(
      PageDirectoryChanged,
    );
  });

  it("keeps dual nodes and allows entering a page-only node to create children", () => {
    const landing = summary("guide");
    const leaf = node("a-leaf");
    const dual = { ...node("b-dual"), hasChildren: true };
    const folder = { ...node("c-folder"), page: null, hasChildren: true };
    const result = readDirectoryPage(
      { ...page([leaf, dual, folder]), page: landing },
      scope,
    );
    expect(result.page.page).toEqual(landing);
    expect(result.page.items).toEqual([leaf, dual, folder]);
    const openedLeaf = readDirectoryPage(
      { ...page([]), path: leaf.path, page: leaf.page },
      { ...scope, path: leaf.path },
    );
    expect(openedLeaf.page.items).toEqual([]);
    expect(openedLeaf.page.page?.id).toBe(leaf.page?.id);
    expect(
      readDirectoryPage({ ...page([]), path: "" }, { ...scope, path: "" }).page
        .items,
    ).toEqual([]);
    expect(() => readDirectoryPage(page([]), scope)).toThrow(
      PageDirectoryChanged,
    );
  });

  it("navigates forward and backward with one version and immutable cursor history", () => {
    const first = readDirectoryPage(page(chunk(), "cGFnZTI"), scope);
    expect(adjacentDirectoryRead(first, "previous")).toBeNull();
    const next = adjacentDirectoryRead(first, "next");
    expect(next).toEqual({
      cursor: "cGFnZTI",
      previous: [null],
      version: 7,
      after: "page-024",
    });
    if (!next) throw new Error("Missing continuation");
    const second = readDirectoryPage(page([node("page-025")]), scope, next);
    expect(second.read.previous).toEqual([null]);
    expect(adjacentDirectoryRead(second, "next")).toBeNull();
    const previous = adjacentDirectoryRead(second, "previous");
    expect(previous).toEqual({ cursor: null, previous: [], version: 7 });
    if (!previous) throw new Error("Missing previous page");
    expect(readDirectoryPage(first.page, scope, previous).page.items).toEqual(
      first.page.items,
    );
    expect(first.read).toEqual(firstDirectoryRead());
    expect(second.read.previous).toEqual([null]);
  });

  it("rejects stale versions, wrong scopes and overlapping continuation rows", () => {
    const first = readDirectoryPage(page(chunk(), "cGFnZTI"), scope);
    const read = adjacentDirectoryRead(first, "next");
    if (!read) throw new Error("Missing continuation");
    for (const response of [
      { ...page([node("page-025")]), version: 8 },
      { ...page([node("page-025")]), language: "en" },
      { ...page([node("page-025")]), path: "other" },
      page([node("page-024")]),
      page([]),
    ])
      expect(() => readDirectoryPage(response, scope, read)).toThrow(
        PageDirectoryChanged,
      );
    const previous = { cursor: null, previous: [], version: 7 };
    expect(() =>
      readDirectoryPage({ ...first.page, version: 8 }, scope, previous),
    ).toThrow(PageDirectoryChanged);
    expect(first.page.version).toBe(7);
    expect(first.page.items).toHaveLength(25);
  });

  it("rejects non-progressing or cycling cursors and unbounded responses", () => {
    const first = readDirectoryPage(page(chunk(), "cGFnZTI"), scope);
    const next = adjacentDirectoryRead(first, "next");
    if (!next) throw new Error("Missing continuation");
    expect(() =>
      readDirectoryPage(page(chunk(25), "cGFnZTI"), scope, next),
    ).toThrow(PageDirectoryChanged);
    const second = readDirectoryPage(page(chunk(25), "cGFnZTM"), scope, next);
    const third = adjacentDirectoryRead(second, "next");
    if (!third) throw new Error("Missing third page");
    expect(() =>
      readDirectoryPage(page(chunk(50), "cGFnZTI"), scope, third),
    ).toThrow(PageDirectoryChanged);
    for (const response of [
      page([...chunk(), node("page-026")]),
      page([node("a")], "cGFnZTI"),
      page(chunk(), "a".repeat(DIRECTORY_LIMITS.cursor + 1)),
      page(chunk(), "bad/cursor"),
      { ...page(chunk()), nextCursor: "" },
      { ...page(chunk()), version: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => readDirectoryPage(response, scope)).toThrow(
        PageDirectoryChanged,
      );
  });

  it("validates direct-child identity, active summaries and closed response fields", () => {
    const valid = node("child");
    for (const item of [
      { ...valid, path: "guide/child/grandchild" },
      { ...valid, segment: "child/grandchild" },
      { ...valid, page: null, hasChildren: false },
      { ...valid, hasChildren: 1 },
      { ...valid, page: { ...valid.page, path: "guide/other" } },
      { ...valid, page: { ...valid.page, language: "en" } },
      { ...valid, page: { ...valid.page, deletedAt: timestamp } },
      {
        ...valid,
        page: {
          ...valid.page,
          publishedRevisionId: "revision",
          publishedAt: null,
        },
      },
      { ...valid, page: { ...valid.page, version: 0 } },
      { ...valid, page: { ...valid.page, id: "bad/id" } },
      { ...valid, page: { ...valid.page, updatedAt: "invalid" } },
      { ...valid, page: { ...valid.page, tags: [123] } },
      {
        ...valid,
        page: { ...valid.page, markdown: "unexpected draft source" },
      },
    ])
      expect(() =>
        readDirectoryPage({ ...page([]), items: [item] }, scope),
      ).toThrow(PageDirectoryChanged);
    expect(() => readDirectoryPage(page([valid, valid]), scope)).toThrow(
      PageDirectoryChanged,
    );
    const duplicateId = node("later");
    expect(() =>
      readDirectoryPage(
        page([
          valid,
          {
            ...duplicateId,
            page: { ...duplicateId.page, id: valid.page?.id },
          } as PageDirectoryItem,
        ]),
        scope,
      ),
    ).toThrow(PageDirectoryChanged);
    expect(() =>
      readDirectoryPage({ ...page([valid]), unexpected: true }, scope),
    ).toThrow(PageDirectoryChanged);
    expect(() =>
      readDirectoryPage(
        { ...page([]), path: "", page: summary("guide") },
        { ...scope, path: "" },
      ),
    ).toThrow(PageDirectoryChanged);
  });

  it("follows server scalar ordering for supplementary Unicode instead of UTF-16 ordering", () => {
    const bmp = "\ufa0e";
    const supplementary = "\u{20000}";
    expect(bmp.normalize("NFKC")).toBe(bmp);
    expect(bmp > supplementary).toBe(true);
    expect(
      readDirectoryPage(
        page([node(bmp), node(supplementary)]),
        scope,
      ).page.items.map((item) => item.segment),
    ).toEqual([bmp, supplementary]);
    expect(() =>
      readDirectoryPage(page([node(supplementary), node(bmp)]), scope),
    ).toThrow(PageDirectoryChanged);
  });
});
