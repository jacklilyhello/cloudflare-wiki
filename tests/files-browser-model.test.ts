import { describe, expect, it } from "vitest";
import type { FileEntry, FilePage } from "../shared/files";
import {
  FileBrowserChanged,
  FolderPathUnavailable,
  fileBrowserQuery,
  fileThumbnailPath,
  mergeFilePages,
  resolveFolderTrail,
} from "../src/admin/files-browser-model";

function folder(id: string, parentId: string | null = null): FileEntry {
  return {
    id,
    parentId,
    kind: "folder",
    name: id,
    version: 1,
    state: "ready",
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
  version = 1,
  cursor: string | null = null,
): FilePage {
  return { items, libraryVersion: version, nextCursor: cursor };
}

describe("file browser reads", () => {
  it("uses bounded folder search and omits the folder entirely for global Trash", () => {
    const active = new URL(
      fileBrowserQuery({
        parentId: "folder",
        trash: false,
        query: "中文 & +",
        cursor: "opaque",
      }),
      "https://example.com",
    );
    expect(Object.fromEntries(active.searchParams)).toEqual({
      state: "active",
      limit: "25",
      parentId: "folder",
      q: "中文 & +",
      cursor: "opaque",
    });
    const root = new URL(
      fileBrowserQuery({ parentId: null, trash: false, query: "" }),
      "https://example.com",
    );
    expect(root.searchParams.get("parentId")).toBe("");
    const trash = new URL(
      fileBrowserQuery({ parentId: "deleted-parent", trash: true, query: "" }),
      "https://example.com",
    );
    expect(trash.searchParams.has("parentId")).toBe(false);
    expect(trash.searchParams.get("state")).toBe("deleted");
  });

  it("preserves the server cursor even when a folder-only view filters every row", () => {
    const files = page([{ ...folder("file"), kind: "file" }], 3, "next-page");
    const merged = mergeFilePages(null, files);
    expect(merged.items.filter((item) => item.kind === "folder")).toEqual([]);
    expect(merged.nextCursor).toBe("next-page");
    expect(mergeFilePages(merged, page([folder("target")], 3))).toEqual(
      page([...files.items, folder("target")], 3),
    );
  });

  it("rejects version drift and overlapping pages instead of mixing library snapshots", () => {
    const old = page([folder("old")], 4, "cursor");
    expect(() => mergeFilePages(old, page([folder("new")], 5))).toThrow(
      FileBrowserChanged,
    );
    expect(() => mergeFilePages(old, page([folder("old")], 4))).toThrow(
      FileBrowserChanged,
    );
    expect(old).toEqual(page([folder("old")], 4, "cursor"));
    expect(() => mergeFilePages(null, page([], 0))).toThrow(FileBrowserChanged);
    expect(() =>
      mergeFilePages(
        null,
        page(Array.from({ length: 51 }, (_, i) => folder(String(i)))),
      ),
    ).toThrow(FileBrowserChanged);
  });

  it("resolves an eight-level path root-first with bounded sequential reads", async () => {
    const reads: string[] = [];
    const trail = await resolveFolderTrail("8", async (id) => {
      reads.push(id);
      return folder(id, id === "1" ? null : String(Number(id) - 1));
    });
    expect(trail.map((entry) => entry.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
    expect(reads).toHaveLength(8);
    expect(
      await resolveFolderTrail(null, async () => {
        throw new Error("unexpected read");
      }),
    ).toEqual([]);
  });

  it("stops cycles, excessive depth, wrong identities and inaccessible parents", async () => {
    let reads = 0;
    await expect(
      resolveFolderTrail("loop", async () => {
        reads++;
        return folder("loop", "loop");
      }),
    ).rejects.toThrow(FolderPathUnavailable);
    expect(reads).toBe(1);
    reads = 0;
    await expect(
      resolveFolderTrail("9", async (id) => {
        reads++;
        return folder(id, String(Number(id) - 1));
      }),
    ).rejects.toThrow(FolderPathUnavailable);
    expect(reads).toBe(8);
    for (const invalid of [
      folder("other"),
      { ...folder("one"), kind: "file" },
      { ...folder("one"), deletedAt: "deleted" },
      { ...folder("one"), state: "pending" },
    ] as FileEntry[])
      await expect(
        resolveFolderTrail("one", async () => invalid),
      ).rejects.toThrow(FolderPathUnavailable);
    const unauthorized = new Error("session required");
    await expect(
      resolveFolderTrail("one", async () => {
        throw unauthorized;
      }),
    ).rejects.toBe(unauthorized);
  });

  it("uses only authenticated verified raster thumbnails and never original uploads for cards", () => {
    const image: FileEntry = {
      ...folder("image"),
      kind: "file",
      source: { bytes: 1024, mime: "image/png", width: 100, height: 100 },
      thumbnailState: "ready",
      thumbnail: { bytes: 256, mime: "image/webp", width: 30, height: 30 },
    };
    expect(fileThumbnailPath(image)).toBe("/api/admin/files/image/thumbnail");
    for (const invalid of [
      folder("folder"),
      { ...image, thumbnailState: "pending" },
      { ...image, thumbnail: null },
      { ...image, source: null },
      {
        ...image,
        source: { ...image.source, mime: "application/octet-stream" },
      },
      { ...image, state: "pending" },
      { ...image, deletedAt: "deleted" },
    ] as FileEntry[])
      expect(fileThumbnailPath(invalid)).toBeNull();
  });
});
