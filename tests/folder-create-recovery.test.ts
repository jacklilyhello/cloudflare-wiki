import { describe, expect, it } from "vitest";
import type { FileEntry, FilePage } from "../shared/files";
import { FileBrowserChanged } from "../src/admin/files-browser-model";
import {
  type FolderCreateAttempt,
  folderInspectionQuery,
  mergeFolderInspection,
} from "../src/admin/folder-create-recovery";

const parentId = "11111111-1111-4111-8111-111111111111";
const attempt: FolderCreateAttempt = { parentId, name: "Target" };
function entry(name = "Target", n = 1): FileEntry {
  return {
    id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
    parentId,
    name,
    kind: "folder",
    state: "ready",
    version: 1,
    thumbnailState: "none",
    alt: null,
    source: null,
    thumbnail: null,
    uploadExpiresAt: null,
    publishedAt: null,
    deletedAt: null,
    createdAt: "2026-09-23T12:00:00.000Z",
    updatedAt: "2026-09-23T12:00:00.000Z",
  };
}
function page(
  items: FileEntry[],
  nextCursor: string | null = null,
  libraryVersion = 4,
): FilePage {
  return { items, nextCursor, libraryVersion };
}

describe("uncertain folder create inspection", () => {
  it("requests one bounded original-folder page without a name query", () => {
    // Compatibility normalization expands this valid name beyond q's limit.
    const expanded = { parentId: null, name: "ﷺ".repeat(20) };
    const query = new URL(
      folderInspectionQuery(expanded),
      "https://example.com",
    );
    expect(Object.fromEntries(query.searchParams)).toEqual({
      parentId: "",
      state: "active",
      limit: "50",
    });
    const previous = mergeFolderInspection(
      attempt,
      null,
      page([entry("Other")], "next-page"),
    );
    expect(
      new URL(
        folderInspectionQuery(attempt, previous),
        "https://example.com",
      ).searchParams.get("cursor"),
    ).toBe("next-page");
  });

  it("matches NFC, trimmed, NFKC and lowercase sibling identities", () => {
    const cases = [
      ["  Ａlpha  ", "alpha"],
      ["A\u030A", "å"],
      ["KELVIN", "kelvin"],
      ["中文资料", "中文资料"],
    ];
    for (const [name, stored] of cases) {
      const existing = entry(stored);
      const result = mergeFolderInspection(
        { ...attempt, name: name as string },
        null,
        page([existing], "more"),
      );
      expect(result.match).toEqual(existing);
      expect(result.nextCursor).toBeNull();
    }
    expect(
      mergeFolderInspection(
        { ...attempt, name: "Straße" },
        null,
        page([entry("STRASSE")]),
      ).match,
    ).toBeNull();
  });

  it("keeps partial absence inconclusive until the last stable-version page", () => {
    const first = mergeFolderInspection(
      attempt,
      null,
      page([entry("One")], "page-two"),
    );
    expect(first).toEqual({
      libraryVersion: 4,
      match: null,
      nextCursor: "page-two",
      readCount: 1,
    });
    const second = mergeFolderInspection(
      attempt,
      first,
      page([entry("Two", 2)], "page-three"),
    );
    expect(second.match).toBeNull();
    expect(second.nextCursor).toBe("page-three");
    const last = mergeFolderInspection(attempt, second, page([]));
    expect(last).toEqual({
      libraryVersion: 4,
      match: null,
      nextCursor: null,
      readCount: 2,
    });
    expect(Object.keys(last).sort()).toEqual([
      "libraryVersion",
      "match",
      "nextCursor",
      "readCount",
    ]);
  });

  it.each(["folder", "file"] as const)(
    "retains a matching %s identity without pretending it is a different kind",
    (kind) => {
      const existing = { ...entry(), kind };
      const result = mergeFolderInspection(
        attempt,
        null,
        page([existing], "unread"),
      );
      expect(result.match).toBe(existing);
      expect(result.match?.kind).toBe(kind);
      expect(result.nextCursor).toBeNull();
    },
  );

  it("rejects changed library versions and repeating cursors without modifying prior inspection", () => {
    const previous = mergeFolderInspection(
      attempt,
      null,
      page([entry("One")], "next"),
    );
    expect(() =>
      mergeFolderInspection(attempt, previous, page([], null, 5)),
    ).toThrow(FileBrowserChanged);
    expect(() =>
      mergeFolderInspection(attempt, previous, page([], "next")),
    ).toThrow(FileBrowserChanged);
    expect(previous).toEqual({
      libraryVersion: 4,
      match: null,
      nextCursor: "next",
      readCount: 1,
    });
  });

  it("rejects scope, lifecycle, identity and duplicate sibling mismatches", () => {
    for (const invalid of [
      { ...entry(), parentId: null },
      { ...entry(), kind: "unknown" },
      { ...entry(), state: "abandoned" },
      { ...entry(), state: "pending" },
      { ...entry(), deletedAt: "deleted" },
      { ...entry(), id: "not-a-file-id" },
      { ...entry(), version: 0 },
      { ...entry(), name: "a/b" },
    ] as FileEntry[])
      expect(() =>
        mergeFolderInspection(attempt, null, page([invalid])),
      ).toThrow(FileBrowserChanged);
    expect(() =>
      mergeFolderInspection(attempt, null, page([entry("One"), entry("Two")])),
    ).toThrow(FileBrowserChanged);
    expect(() =>
      mergeFolderInspection(
        attempt,
        null,
        page([entry("Target"), entry("ＴＡＲＧＥＴ", 2)]),
      ),
    ).toThrow(FileBrowserChanged);
  });

  it("rejects oversized pages and malformed versions or cursors", () => {
    for (const invalid of [
      page(Array.from({ length: 51 }, (_, i) => entry(`Name ${i}`, i))),
      page([], null, 0),
      page([], null, Number.MAX_SAFE_INTEGER + 1),
      page([], ""),
      page([], "a".repeat(4097)),
      page([], "not a cursor"),
    ])
      expect(() => mergeFolderInspection(attempt, null, invalid)).toThrow(
        FileBrowserChanged,
      );
  });

  it("cannot continue a completed inspection or scan an invalid original parent", () => {
    const completed = mergeFolderInspection(attempt, null, page([]));
    expect(() => folderInspectionQuery(attempt, completed)).toThrow(
      FileBrowserChanged,
    );
    expect(() => mergeFolderInspection(attempt, completed, page([]))).toThrow(
      FileBrowserChanged,
    );
    const matched = mergeFolderInspection(
      attempt,
      null,
      page([entry()], "more"),
    );
    expect(() => folderInspectionQuery(attempt, matched)).toThrow(
      FileBrowserChanged,
    );
    expect(() =>
      folderInspectionQuery({ ...attempt, parentId: "bad" }),
    ).toThrow(FileBrowserChanged);
  });
});
