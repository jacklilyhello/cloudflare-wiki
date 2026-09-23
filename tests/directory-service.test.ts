import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminTranslation } from "../shared/content";
import type { Language } from "../shared/contracts";
import type {
  DirectoryMovePreview,
  PageDirectoryOptions,
} from "../shared/directories";
import type { ContentWriteAccess } from "../worker/auth/access";
import { PageDirectoryService } from "../worker/content/directories";
import { getPage, searchPages } from "../worker/content/public";
import type { ContentService } from "../worker/content/service";
import { RedirectService } from "../worker/redirects/service";
import { contentFixture } from "./content-fixture";

const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
let content: ContentService;
let service: PageDirectoryService;
let access: ContentWriteAccess;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
  const fixture = await contentFixture(env.DB);
  content = fixture.service;
  access = fixture.access;
  service = new PageDirectoryService(env.DB, access);
});
async function page(
  path: string,
  published = false,
  language: Language = "en",
) {
  let value = await content.createTranslation({
    language,
    path,
    title: `Title ${path}`.slice(0, 200),
    description: "Summary",
    markdown: "Body snapshot.",
    tags: ["topic"],
  });
  if (published)
    value = await content.publish(
      value.id,
      value.version,
      value.draftRevisionId ?? "",
    );
  return value;
}
function commit(preview: DirectoryMovePreview) {
  return {
    fromPath: preview.fromPath,
    toPath: preview.toPath,
    expectedVersion: preview.version,
    expectedMembers: preview.members.map(({ id, version }) => ({
      id,
      version,
    })),
  };
}
async function token() {
  const result = await env.DB.prepare(
    "SELECT move_token FROM route_registries WHERE language='en'",
  ).first<{ move_token: string | null }>();
  expect(result?.move_token).toBeNull();
}
async function alias(path: string, target: AdminTranslation) {
  const redirects = new RedirectService(env.DB, access);
  await redirects.create(target.language, {
    expectedVersion: (await redirects.list(target.language)).version,
    path,
    translationId: target.id,
  });
}

describe("virtual page directories", () => {
  it("lists immediate active canonical nodes with both landing pages and children", async () => {
    const landing = await page("directory");
    const branch = await page("directory/branch", true);
    await page("directory/branch/deep/leaf");
    const leaf = await page("directory/leaf");
    await page("directory/implicit/deep");
    await page("directory/other-language", false, "zh");
    const deleted = await page("directory/trashed");
    await content.softDelete(deleted.id, deleted.version);
    await alias("directory/alias", leaf);
    const listing = await service.list("en", { path: "directory" });
    expect(listing.page).toMatchObject({
      id: landing.id,
      title: "Title directory",
    });
    expect(
      listing.items.map(({ segment, hasChildren, page }) => ({
        segment,
        hasChildren,
        id: page?.id ?? null,
      })),
    ).toEqual([
      { segment: "branch", hasChildren: true, id: branch.id },
      { segment: "implicit", hasChildren: true, id: null },
      { segment: "leaf", hasChildren: false, id: leaf.id },
    ]);
    expect(JSON.stringify(listing)).not.toContain("Body snapshot.");
    expect(listing.nextCursor).toBeNull();
    expect(
      (await service.list("en", { path: "directory/leaf" })).items,
    ).toEqual([]);
    await expect(
      service.list("en", { path: "directory/alias" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("uses literal path boundaries and keeps an empty language root valid", async () => {
    await page("literal_/one");
    await page("literalx/two");
    await page("literal_-suffix/three");
    expect(
      (await service.list("en", { path: "literal_" })).items.map(
        (item) => item.segment,
      ),
    ).toEqual(["one"]);
    await expect(service.list("en", { path: "literal" })).rejects.toMatchObject(
      { status: 404 },
    );
    expect((await service.list("zh")).path).toBe("");
  });

  it("paginates Chinese names with scope-bound UTF-8 cursors and no duplicates", async () => {
    for (const name of ["一", "二", "三", "四"]) await page(`中文目录/${name}`);
    const first = await service.list("en", { path: "中文目录", limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list("en", {
      path: "中文目录",
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(
      new Set([...first.items, ...second.items].map((item) => item.path)).size,
    ).toBe(4);
    expect(second.nextCursor).toBeNull();
    for (const options of [
      { path: "other", cursor: first.nextCursor },
      { path: "中文目录", cursor: `${first.nextCursor}=` },
    ])
      await expect(
        service.list("en", options as PageDirectoryOptions),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.list("zh", { path: "中文目录", cursor: first.nextCursor ?? "" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("invalidates directory and redirect cursors after legacy delete and restore", async () => {
    const firstPage = await page("cursor-directory/a");
    const secondPage = await page("cursor-directory/b");
    await alias("cursor-alias-a", firstPage);
    await alias("cursor-alias-b", secondPage);
    const redirects = new RedirectService(env.DB, access);
    const before = await service.list("en", {
      path: "cursor-directory",
      limit: 1,
    });
    const aliases = await redirects.list("en", { limit: 1 });
    const deleted = await content.softDelete(secondPage.id, secondPage.version);
    await expect(
      service.list("en", {
        path: "cursor-directory",
        cursor: before.nextCursor ?? "",
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      redirects.list("en", { cursor: aliases.nextCursor ?? "" }),
    ).rejects.toMatchObject({ status: 412 });
    const version = (await service.list("en")).version;
    await content.restoreDeleted(deleted.id, deleted.version);
    expect((await service.list("en")).version).toBe(version + 1);
    await token();
  });

  it.each([
    { path: "../bad" },
    { path: "", limit: 0 },
    { limit: 51 },
    { limit: null },
    { cursor: "%%%%" },
    { q: "unsupported" },
    { path: "Guide" },
    { path: "admin/docs" },
  ])("rejects malformed and unsupported list input %j", async (options) => {
    await expect(
      service.list("en", options as PageDirectoryOptions),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("directory movement", () => {
  it("moves landing and descendants atomically while retaining Trash, revisions, aliases and publication time", async () => {
    const landing = await page("move-tree", true);
    const child = await page("move-tree/nested/child");
    const trashed = await page("move-tree/trashed");
    await content.softDelete(trashed.id, trashed.version);
    await page("move-tree/translated", false, "zh");
    await alias("manual-history", landing);
    const revisions = (
      await env.DB.prepare("SELECT * FROM page_revisions ORDER BY id").all()
    ).results;
    const preview = await service.preview("en", {
      fromPath: "move-tree",
      toPath: "renamed-tree",
    });
    expect(preview.members.map((member) => member.fromPath)).toEqual([
      "move-tree",
      "move-tree/nested/child",
    ]);
    expect(preview.publishedCount).toBe(1);
    const result = await service.move("en", commit(preview));
    expect(result.version).toBe(preview.version + 4);
    expect(result.items).toMatchObject([
      {
        id: landing.id,
        path: "renamed-tree",
        version: landing.version + 1,
        publishedAt: landing.publishedAt,
        publishedRevisionId: landing.publishedRevisionId,
        draftRevisionId: landing.draftRevisionId,
      },
      {
        id: child.id,
        path: "renamed-tree/nested/child",
        version: child.version + 1,
        publishedRevisionId: null,
      },
    ]);
    expect(
      (await env.DB.prepare("SELECT * FROM page_revisions ORDER BY id").all())
        .results,
    ).toEqual(revisions);
    expect((await content.getAdminTranslation(trashed.id)).path).toBe(
      "move-tree/trashed",
    );
    for (const old of ["move-tree", "manual-history"])
      expect((await getPage(env.DB, "en", old))?.path).toBe("renamed-tree");
    expect(await getPage(env.DB, "en", "move-tree/nested/child")).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT path FROM published_search WHERE translation_id=?",
      )
        .bind(landing.id)
        .first(),
    ).toEqual({ path: "renamed-tree" });
    expect(
      await env.DB.prepare(
        "SELECT path FROM published_search_fts WHERE translation_id=?",
      )
        .bind(landing.id)
        .first(),
    ).toEqual({ path: "renamed-tree" });
    expect(
      (await searchPages(env.DB, "en", "renamed-tree")).some(
        (item) => item.path === "/en/renamed-tree",
      ),
    ).toBe(true);
    const events = (
      await env.DB.prepare(
        "SELECT translation_id,from_path,to_path FROM page_events WHERE event_type='move' ORDER BY from_path",
      ).all()
    ).results;
    expect(events).toEqual([
      {
        translation_id: landing.id,
        from_path: "move-tree",
        to_path: "renamed-tree",
      },
      {
        translation_id: child.id,
        from_path: "move-tree/nested/child",
        to_path: "renamed-tree/nested/child",
      },
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM audit_records WHERE action='page.move'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(2);
    await token();
  });

  it("rejects the whole source beyond 25 pages without truncating", async () => {
    for (let i = 0; i < 26; i++) await page(`large-tree/page-${i}`);
    await expect(
      service.preview("en", { fromPath: "large-tree", toPath: "elsewhere" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS n FROM page_events WHERE event_type='move'",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await token();
  });

  it("rejects occupied target subtrees, aliases, deleted and route-less canonical reservations", async () => {
    const source = await page("occupied-source/item");
    await page("target-private/deeper/item");
    const deleted = await page("target-trash/deeper/item");
    await content.softDelete(deleted.id, deleted.version);
    await alias("target-alias/deeper", source);
    const missing = await page("target-missing-route");
    // A route can be absent in an inconsistent legacy store. Canonical path
    // ownership must still block the directory destination.
    await env.DB.exec("DROP TRIGGER page_routes_canonical_delete");
    await env.DB.prepare("DELETE FROM page_routes WHERE translation_id=?")
      .bind(missing.id)
      .run();
    for (const toPath of [
      "target-private",
      "target-trash",
      "target-alias",
      "target-missing-route",
    ])
      await expect(
        service.preview("en", { fromPath: "occupied-source", toPath }),
      ).rejects.toMatchObject({ status: 409 });
    await token();
  });

  it("enforces path rewrite limits and rejects root, overlap and empty source", async () => {
    await page(`length-source/${"a".repeat(220)}`);
    await expect(
      service.preview("en", {
        fromPath: "length-source",
        toPath: "b".repeat(30),
      }),
    ).rejects.toMatchObject({ status: 400 });
    for (const [fromPath, toPath] of [
      ["", "valid"],
      ["valid", ""],
      ["same", "same"],
      ["parent", "parent/child"],
      ["parent/child", "parent"],
    ] as const)
      await expect(
        service.preview("en", { fromPath, toPath }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.preview("en", { fromPath: "not-found", toPath: "free" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("requires exactly the reviewed members and version without consuming any claim", async () => {
    await page("reviewed/a");
    await page("reviewed/b");
    const preview = await service.preview("en", {
      fromPath: "reviewed",
      toPath: "reviewed-new",
    });
    const input = commit(preview);
    const first = input.expectedMembers[0];
    if (!first) throw new Error("Missing fixture member.");
    await expect(
      service.move("en", {
        ...input,
        expectedMembers: [first, first],
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.move("en", {
        ...input,
        expectedMembers: input.expectedMembers.slice(0, 1),
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      service.move("en", {
        ...input,
        expectedVersion: input.expectedVersion - 1,
      }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      service.move("en", {
        ...input,
        expectedMembers: input.expectedMembers.map((item) => ({
          ...item,
          version: item.version + 1,
        })),
      }),
    ).rejects.toMatchObject({ status: 412 });
    await token();
  });

  it("adds directory metadata without rewriting prior records or breaking legacy writes", async () => {
    await reset();
    const index = migrations.findIndex(
      (migration) => migration.name === "0011_page_directories.sql",
    );
    await applyD1Migrations(env.DB, migrations.slice(0, index));
    const fixture = await contentFixture(env.DB);
    content = fixture.service;
    const initial = await page("legacy-directory/one", true);
    const audit = (
      await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all()
    ).results;
    await applyD1Migrations(env.DB, migrations);
    service = new PageDirectoryService(env.DB, fixture.access);
    expect(
      (await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all())
        .results,
    ).toEqual(audit);
    const moved = await content.move(
      initial.id,
      initial.version,
      "legacy-directory/two",
    );
    await content.softDelete(moved.id, moved.version);
    expect((await service.list("en")).version).toBeGreaterThan(1);
    await token();
  });

  it("sanitizes preparation and batch storage failures", async () => {
    for (const method of ["prepare", "batch"] as const) {
      const unavailable = new Proxy(env.DB, {
        get(target, key) {
          if (key === method)
            return () => {
              throw new Error("private storage diagnostic");
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failing = new PageDirectoryService(unavailable, access);
      await expect(failing.list("en")).rejects.toThrow(
        "Directory storage is temporarily unavailable.",
      );
      await expect(
        failing.preview("en", { fromPath: "source", toPath: "target" }),
      ).rejects.toThrow("Directory storage is temporarily unavailable.");
    }
  });
});
