import { describe, expect, it } from "vitest";
import type { AdminTranslation } from "../shared/content";
import type {
  DirectoryMovePreview,
  PageDirectory,
} from "../shared/directories";
import {
  DirectoryInspectionError,
  type DirectoryInspectionReader,
  directoryCommit,
  inspectDirectoryMove,
  verifyDirectoryMoveResult,
} from "../src/admin/directory-move-recovery";

function item<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture item");
  return value;
}
function preview(): DirectoryMovePreview {
  return {
    language: "zh",
    fromPath: "教程",
    toPath: "文档",
    version: 10,
    members: [
      {
        id: "page-a",
        version: 2,
        fromPath: "教程",
        toPath: "文档",
        title: "首页",
        published: true,
      },
      {
        id: "page-b",
        version: 1,
        fromPath: "教程/安装",
        toPath: "文档/安装",
        title: "安装",
        published: false,
      },
    ],
    publishedCount: 1,
  };
}
function pages(moved = false): AdminTranslation[] {
  return preview().members.map((member) => ({
    id: member.id,
    pageId: `identity-${member.id}`,
    language: "zh",
    path: moved ? member.toPath : member.fromPath,
    version: member.version + (moved ? 1 : 0),
    revisionSeq: 1,
    draftRevisionId: `revision-${member.id}`,
    publishedRevisionId: member.published ? `revision-${member.id}` : null,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    publishedAt: member.published ? "2026-09-23T10:00:00.000Z" : null,
    deletedAt: null,
  }));
}
function reader(first = pages(), second = first, versions = [10, 10]) {
  let registryCount = 0;
  let pageCount = 0;
  const calls: string[] = [];
  const value: DirectoryInspectionReader = {
    registry: async (language) => {
      calls.push(`registry:${language}`);
      return {
        language,
        path: "",
        version: versions[registryCount++] ?? -1,
        page: null,
        items: [],
        nextCursor: null,
      };
    },
    page: async (id) => {
      calls.push(`page:${id}`);
      const state = pageCount++ < 2 ? first : second;
      return structuredClone(state.find((page) => page.id === id) ?? null);
    },
  };
  return { value, calls };
}
const inspect = (
  value: DirectoryInspectionReader,
  signal = new AbortController().signal,
) => inspectDirectoryMove({ preview: preview() }, value, signal);

describe("reviewed directory move manifest", () => {
  it("builds only the exact reviewed version manifest without mutating it", () => {
    const original = preview();
    const result = directoryCommit(original);
    expect(result).toEqual({
      fromPath: "教程",
      toPath: "文档",
      expectedVersion: 10,
      expectedMembers: [
        { id: "page-a", version: 2 },
        { id: "page-b", version: 1 },
      ],
    });
    item(result.expectedMembers, 0).version = 99;
    expect(item(original.members, 0).version).toBe(2);
  });
  it.each([
    "duplicate",
    "wrong-prefix",
    "wrong-target",
    "published-count",
    "root",
    "overlap",
    "overflow",
    "too-many",
  ])("rejects a malformed %s preview before dispatch", (kind) => {
    const value = preview();
    if (kind === "duplicate")
      item(value.members, 1).id = item(value.members, 0).id;
    if (kind === "wrong-prefix") item(value.members, 0).fromPath = "其他";
    if (kind === "wrong-target") item(value.members, 0).toPath = "其他";
    if (kind === "published-count") value.publishedCount = 0;
    if (kind === "root") value.fromPath = "";
    if (kind === "overlap") value.toPath = "教程/嵌套";
    if (kind === "overflow")
      item(value.members, 0).version = Number.MAX_SAFE_INTEGER;
    if (kind === "too-many")
      value.members = Array.from({ length: 26 }, () => item(value.members, 0));
    expect(() => directoryCommit(value)).toThrow(DirectoryInspectionError);
  });
  it("verifies a complete response and rejects missing, duplicate or incorrect outcomes", () => {
    const result = {
      language: "zh" as const,
      fromPath: "教程",
      toPath: "文档",
      version: 14,
      items: pages(true),
    };
    expect(verifyDirectoryMoveResult(preview(), result)).toBe(result);
    for (const items of [
      [item(result.items, 0)],
      [item(result.items, 0), item(result.items, 0)],
      pages(false),
    ])
      expect(() =>
        verifyDirectoryMoveResult(preview(), { ...result, items }),
      ).toThrow(DirectoryInspectionError);
  });
});
describe("ambiguous directory move readback", () => {
  it("reads two complete rounds between registry fences and makes no write", async () => {
    const state = reader();
    expect(await inspect(state.value)).toMatchObject({
      kind: "unchanged",
      stable: true,
      version: 10,
    });
    expect(state.calls).toEqual([
      "registry:zh",
      "page:page-a",
      "page:page-b",
      "page:page-a",
      "page:page-b",
      "registry:zh",
    ]);
  });
  it("recognizes the observed moved state without hardcoding registry increments", async () => {
    expect(
      await inspect(reader(pages(true), pages(true), [71, 71]).value),
    ).toMatchObject({ kind: "moved", stable: true });
  });
  it.each(["newer-registry", "mixed", "newer-page", "deleted", "missing"])(
    "keeps %s distinct from unchanged or completed",
    async (kind) => {
      const state = pages(true);
      const versions = [14, 14];
      if (kind === "newer-registry") state.splice(0, 2, ...pages());
      if (kind === "mixed") state[1] = item(pages(), 1);
      if (kind === "newer-page") item(state, 0).version++;
      if (kind === "deleted")
        item(state, 0).deletedAt = "2026-09-23T10:01:00.000Z";
      if (kind === "missing") state.pop();
      expect(await inspect(reader(state, state, versions).value)).toMatchObject(
        { kind: "changed", stable: true },
      );
    },
  );
  it.each(["draft", "publication", "registry"])(
    "detects %s changes during inspection",
    async (kind) => {
      const second = pages(true);
      if (kind === "draft") {
        item(second, 0).version++;
        item(second, 0).draftRevisionId = "later-revision";
      }
      if (kind === "publication") {
        item(second, 0).version++;
        item(second, 0).publishedRevisionId = null;
        item(second, 0).publishedAt = null;
      }
      expect(
        await inspect(
          reader(pages(true), second, kind === "registry" ? [14, 15] : [14, 14])
            .value,
        ),
      ).toMatchObject({ kind: "changed", stable: false });
    },
  );
  it.each([
    "wrong-id",
    "wrong-language",
    "bad-version",
    "bad-path",
    "bad-revision",
    "bad-registry",
  ])("rejects malformed %s responses", async (kind) => {
    const state = pages();
    if (kind === "wrong-id") item(state, 0).id = "wrong-id";
    if (kind === "wrong-language") item(state, 0).language = "en";
    if (kind === "bad-version") item(state, 0).version = NaN;
    if (kind === "bad-path") item(state, 0).path = "../outside";
    if (kind === "bad-revision") item(state, 0).draftRevisionId = null;
    const source = reader(state).value;
    if (kind === "wrong-id") source.page = async () => item(state, 0);
    if (kind === "bad-registry")
      source.registry = async () => ({ path: "not-root" }) as PageDirectory;
    await expect(inspect(source)).rejects.toThrow(DirectoryInspectionError);
  });
  it.each(["first", "second", "last-fence"])(
    "retains unresolved recovery if the %s read fails",
    async (point) => {
      const source = reader().value;
      let calls = 0;
      const failure = new Error("Read failed");
      if (point === "last-fence") {
        const original = source.registry;
        source.registry = async (...args) => {
          if (++calls === 2) throw failure;
          return original(...args);
        };
      } else {
        const original = source.page;
        source.page = async (...args) => {
          if (++calls === (point === "first" ? 1 : 3)) throw failure;
          return original(...args);
        };
      }
      await expect(inspect(source)).rejects.toBe(failure);
    },
  );
  it("stops an aborted inspection without dispatching another read", async () => {
    const controller = new AbortController();
    const source = reader();
    controller.abort();
    await expect(inspect(source.value, controller.signal)).rejects.toThrow();
    expect(source.calls).toEqual([]);
  });
});
