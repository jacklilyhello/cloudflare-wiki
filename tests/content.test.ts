import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { DraftInput } from "../shared/content";
import { MARKDOWN_LIMITS } from "../shared/markdown";
import { compileSearchQuery } from "../shared/search";
import { ContentError, type ContentService } from "../worker/content/service";
import { contentFixture } from "./content-fixture";

let service: ContentService;
beforeEach(async () => {
  ({ service } = await contentFixture(env.DB));
});
function draft(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    title: "Test article",
    description: "An original test article.",
    markdown: "## Public heading\n\nInitial public text.",
    tags: ["test"],
    changeNote: "Test revision",
    ...overrides,
  };
}
function newPath() {
  return `test-${crypto.randomUUID()}`;
}
async function create(overrides: Partial<DraftInput> = {}) {
  return service.createTranslation({
    language: "en",
    path: newPath(),
    ...draft(overrides),
  });
}
async function publicBody(id: string) {
  return env.DB.prepare(
    "SELECT r.markdown FROM page_translations t JOIN page_revisions r ON r.translation_id=t.id AND r.id=t.published_revision_id WHERE t.id=? AND t.deleted_at IS NULL",
  )
    .bind(id)
    .first<{ markdown: string }>();
}
async function counts(id: string) {
  return {
    revisions: (
      await env.DB.prepare(
        "SELECT count(*) AS count FROM page_revisions WHERE translation_id=?",
      )
        .bind(id)
        .first<{ count: number }>()
    )?.count,
    events: (
      await env.DB.prepare(
        "SELECT count(*) AS count FROM page_events WHERE translation_id=?",
      )
        .bind(id)
        .first<{ count: number }>()
    )?.count,
    search: (
      await env.DB.prepare(
        "SELECT count(*) AS count FROM published_search WHERE translation_id=?",
      )
        .bind(id)
        .first<{ count: number }>()
    )?.count,
    fts: (
      await env.DB.prepare(
        "SELECT count(*) AS count FROM published_search_fts WHERE translation_id=?",
      )
        .bind(id)
        .first<{ count: number }>()
    )?.count,
  };
}

describe("D1 content revision service in workerd", () => {
  it("creates stable bilingual identities with private initial drafts", async () => {
    const en = await create();
    const zh = await service.createTranslation({
      ...draft({ title: "中文翻译" }),
      language: "zh",
      path: newPath(),
      pageId: en.pageId,
    });
    expect(en.id).not.toBe(zh.id);
    expect(en.pageId).toBe(zh.pageId);
    expect(en.version).toBe(1);
    expect(en.revisionSeq).toBe(1);
    expect(en.publishedRevisionId).toBeNull();
    expect(await publicBody(en.id)).toBeNull();
    expect(await counts(en.id)).toEqual({
      revisions: 1,
      events: 1,
      search: 0,
      fts: 0,
    });
    await expect(
      service.createTranslation({
        ...draft(),
        language: "en",
        path: newPath(),
        pageId: en.pageId,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.getAdminTranslation(en.id)).version).toBe(1);
  });

  it("publishes an explicit draft and preserves it when a newer private draft is saved", async () => {
    const initial = await create();
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const edited = await service.saveDraft(
      initial.id,
      published.version,
      draft({
        title: "PRIVATE TITLE",
        markdown: "private-canary-draft",
        tags: ["private-tag"],
      }),
    );
    expect(edited.version).toBe(3);
    expect(edited.draftRevisionId).not.toBe(published.publishedRevisionId);
    expect(edited.publishedRevisionId).toBe(published.publishedRevisionId);
    expect((await publicBody(initial.id))?.markdown).toBe(draft().markdown);
    const search = await env.DB.prepare(
      "SELECT title,body_text,revision_id FROM published_search WHERE translation_id=?",
    )
      .bind(initial.id)
      .first<{ title: string; body_text: string; revision_id: string }>();
    expect(search?.title).toBe("Test article");
    expect(search?.body_text).not.toContain("private-canary");
    expect(search?.revision_id).toBe(published.publishedRevisionId);
    expect(await counts(initial.id)).toEqual({
      revisions: 2,
      events: 3,
      search: 1,
      fts: 1,
    });
    await expect(
      service.publish(
        initial.id,
        edited.version,
        published.publishedRevisionId ?? "",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts exactly one concurrent save and leaves no losing revision or audit event", async () => {
    const initial = await create();
    const results = await Promise.allSettled([
      service.saveDraft(
        initial.id,
        initial.version,
        draft({ markdown: "Writer A" }),
      ),
      service.saveDraft(
        initial.id,
        initial.version,
        draft({ markdown: "Writer B" }),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
      ContentError,
    );
    expect(failure?.status === "rejected" && failure.reason.status).toBe(412);
    expect(await counts(initial.id)).toEqual({
      revisions: 2,
      events: 2,
      search: 0,
      fts: 0,
    });
    const state = await service.getAdminTranslation(initial.id);
    expect(state.version).toBe(2);
    expect(state.revisionSeq).toBe(2);
  });

  it("rolls back an inserted revision when a later batch constraint fails", async () => {
    const initial = await create();
    await env.DB.prepare(
      "INSERT INTO page_events(id,translation_id,event_type,version,change_note,created_at) VALUES(?,?,'save_draft',2,'test collision',?)",
    )
      .bind(crypto.randomUUID(), initial.id, new Date().toISOString())
      .run();
    await expect(
      service.saveDraft(
        initial.id,
        initial.version,
        draft({ markdown: "Must roll back" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await counts(initial.id)).toEqual({
      revisions: 1,
      events: 2,
      search: 0,
      fts: 0,
    });
    expect(await service.getAdminTranslation(initial.id)).toEqual(initial);
  });

  it("rolls back replaced public metadata and FTS when publication fails later in the batch", async () => {
    const initial = await create();
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const edited = await service.saveDraft(
      initial.id,
      published.version,
      draft({
        title: "Uncommitted replacement",
        markdown: "replacement-index-canary",
      }),
    );
    await env.DB.prepare(
      "INSERT INTO page_events(id,translation_id,event_type,version,change_note,created_at) VALUES(?,?,'publish',?,'test collision',?)",
    )
      .bind(
        crypto.randomUUID(),
        initial.id,
        edited.version + 1,
        new Date().toISOString(),
      )
      .run();
    await expect(
      service.publish(initial.id, edited.version, edited.draftRevisionId ?? ""),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.getAdminTranslation(initial.id)).toEqual(edited);
    expect((await publicBody(initial.id))?.markdown).toBe(draft().markdown);
    expect(
      (
        await env.DB.prepare(
          "SELECT revision_id FROM published_search WHERE translation_id=?",
        )
          .bind(initial.id)
          .first<{ revision_id: string }>()
      )?.revision_id,
    ).toBe(published.publishedRevisionId);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS count FROM published_search_fts WHERE published_search_fts MATCH ? AND translation_id=?",
        )
          .bind('"replacement" AND "canary"', initial.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect((await counts(initial.id)).fts).toBe(1);
  });

  it("serializes publishing against a concurrent draft save using the same version", async () => {
    const initial = await create();
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const edited = await service.saveDraft(
      initial.id,
      published.version,
      draft({ markdown: "Approved candidate" }),
    );
    const results = await Promise.allSettled([
      service.publish(initial.id, edited.version, edited.draftRevisionId ?? ""),
      service.saveDraft(
        initial.id,
        edited.version,
        draft({ markdown: "Unapproved newer candidate" }),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason.status).toBe(412);
    const state = await service.getAdminTranslation(initial.id);
    const indexed = await env.DB.prepare(
      "SELECT revision_id,body_text FROM published_search WHERE translation_id=?",
    )
      .bind(initial.id)
      .first<{ revision_id: string; body_text: string }>();
    expect(indexed?.revision_id).toBe(state.publishedRevisionId);
    expect(indexed?.body_text).not.toContain("Unapproved newer candidate");
    expect((await counts(initial.id)).events).toBe(4);
    expect(state.version).toBe(4);
  });

  it("restores an old revision into a new draft without restoring an old publication or path", async () => {
    const initial = await create();
    const firstPublished = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const second = await service.saveDraft(
      initial.id,
      firstPublished.version,
      draft({ markdown: "Second public version" }),
    );
    const secondPublished = await service.publish(
      initial.id,
      second.version,
      second.draftRevisionId ?? "",
    );
    const moved = await service.move(
      initial.id,
      secondPublished.version,
      newPath(),
    );
    const restored = await service.restoreRevision(
      initial.id,
      moved.version,
      initial.draftRevisionId ?? "",
      "Restore initial content",
    );
    expect(restored.path).toBe(moved.path);
    expect(restored.publishedRevisionId).toBe(
      secondPublished.publishedRevisionId,
    );
    expect(restored.draftRevisionId).not.toBe(initial.draftRevisionId);
    expect(restored.revisionSeq).toBe(3);
    const copied = await service.getRevision(
      initial.id,
      restored.draftRevisionId ?? "",
    );
    expect(copied.markdown).toBe(draft().markdown);
    expect(copied.restoredFromRevisionId).toBe(initial.draftRevisionId);
    expect((await publicBody(initial.id))?.markdown).toBe(
      "Second public version",
    );
    expect(
      (
        await env.DB.prepare(
          "SELECT body_text FROM published_search WHERE translation_id=?",
        )
          .bind(initial.id)
          .first<{ body_text: string }>()
      )?.body_text,
    ).toBe("Second public version");
    const history = await service.listRevisions(initial.id);
    expect(history.map((entry) => entry.revisionNo)).toEqual([3, 2, 1]);
    expect(history[0]).not.toHaveProperty("markdown");
    expect(
      (await service.listRevisions(initial.id, 3, 1)).map(
        (entry) => entry.revisionNo,
      ),
    ).toEqual([2]);
  });

  it("keeps old route aliases and updates published search atomically during moves", async () => {
    const initial = await create();
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const moved = await service.move(initial.id, published.version, newPath());
    const paths = await env.DB.prepare(
      "SELECT path FROM page_routes WHERE translation_id=? ORDER BY path",
    )
      .bind(initial.id)
      .all<{ path: string }>();
    expect(paths.results.map((entry) => entry.path).sort()).toEqual(
      [initial.path, moved.path].sort(),
    );
    const indexed = await env.DB.prepare(
      "SELECT path,revision_id FROM published_search WHERE translation_id=?",
    )
      .bind(initial.id)
      .first<{ path: string; revision_id: string }>();
    expect(indexed?.path).toBe(moved.path);
    expect(indexed?.revision_id).toBe(published.publishedRevisionId);
    const returned = await service.move(
      initial.id,
      moved.version,
      initial.path,
    );
    expect(returned.path).toBe(initial.path);
    expect((await counts(initial.id)).fts).toBe(1);
  });

  it("rejects route collisions without partial publication, history or identity changes", async () => {
    const initial = await create();
    const occupied = await create();
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const before = await counts(initial.id);
    await expect(
      service.move(initial.id, published.version, occupied.path),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.getAdminTranslation(initial.id)).toEqual(published);
    expect(await counts(initial.id)).toEqual(before);
    const pagesBefore = await env.DB.prepare(
      "SELECT count(*) AS count FROM pages",
    ).first<{ count: number }>();
    await expect(
      service.createTranslation({
        ...draft(),
        language: "en",
        path: occupied.path,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM pages").first(),
    ).toEqual(pagesBefore);
  });

  it("unpublishes and deletes without leaving searchable content, and undeletes privately", async () => {
    const initial = await create();
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const hidden = await service.unpublish(initial.id, published.version);
    expect(hidden.publishedRevisionId).toBeNull();
    expect(hidden.publishedAt).toBeNull();
    expect(await publicBody(initial.id)).toBeNull();
    expect((await counts(initial.id)).fts).toBe(0);
    const republished = await service.publish(
      initial.id,
      hidden.version,
      hidden.draftRevisionId ?? "",
    );
    const removed = await service.softDelete(initial.id, republished.version);
    expect(removed.deletedAt).not.toBeNull();
    expect(removed.publishedRevisionId).toBeNull();
    expect(await publicBody(initial.id)).toBeNull();
    const recovered = await service.restoreDeleted(initial.id, removed.version);
    expect(recovered.deletedAt).toBeNull();
    expect(recovered.publishedRevisionId).toBeNull();
    expect(recovered.draftRevisionId).toBe(initial.draftRevisionId);
    expect(await publicBody(initial.id)).toBeNull();
    expect(await counts(initial.id)).toEqual({
      revisions: 1,
      events: 6,
      search: 0,
      fts: 0,
    });
  });

  it("enforces immutable revisions and rejects pointers or restores owned by another page", async () => {
    const first = await create();
    const second = await create();
    await expect(
      env.DB.prepare("UPDATE page_revisions SET markdown='changed' WHERE id=?")
        .bind(first.draftRevisionId)
        .run(),
    ).rejects.toThrow("revision_immutable");
    await expect(
      env.DB.prepare("DELETE FROM page_revisions WHERE id=?")
        .bind(first.draftRevisionId)
        .run(),
    ).rejects.toThrow("revision_immutable");
    await expect(
      env.DB.prepare(
        "UPDATE page_translations SET draft_revision_id=? WHERE id=?",
      )
        .bind(second.draftRevisionId, first.id)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
    await expect(
      service.restoreRevision(
        first.id,
        first.version,
        second.draftRevisionId ?? "",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.getAdminTranslation(first.id)).toEqual(first);
  });

  it("indexes only the published Chinese text with matching FTS and metadata row IDs", async () => {
    const initial = await service.createTranslation({
      ...draft({
        title: "阅读指南",
        markdown: "## 媒体库\n\n这是可靠的阅读指南。",
        tags: ["中文"],
      }),
      language: "zh",
      path: `中文/${newPath()}`,
    });
    const published = await service.publish(
      initial.id,
      initial.version,
      initial.draftRevisionId ?? "",
    );
    const query = compileSearchQuery("阅读指南");
    const rows = await env.DB.prepare(
      "SELECT s.translation_id,s.revision_id FROM published_search_fts f JOIN published_search s ON s.rowid=f.rowid WHERE published_search_fts MATCH ? AND s.translation_id=?",
    )
      .bind(query, initial.id)
      .all<{ translation_id: string; revision_id: string }>();
    expect(rows.results).toEqual([
      {
        translation_id: initial.id,
        revision_id: published.publishedRevisionId,
      },
    ]);
    await service.saveDraft(
      initial.id,
      published.version,
      draft({ markdown: "draft-only-needle" }),
    );
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) AS count FROM published_search_fts WHERE published_search_fts MATCH ? AND translation_id=?",
        )
          .bind('"draft" AND "needle"', initial.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it.each([
    "../escape",
    "/leading",
    "trailing/",
    "two//slashes",
    "UPPER",
    "a%2fb",
    "a\\b",
    "a b",
    "search",
    "admin/page",
    "ＡＢＣ",
    "",
  ])("rejects invalid or reserved path %s", async (path) => {
    await expect(
      service.createTranslation({ ...draft(), language: "en", path }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("validates limits and optimistic preconditions without modifying content", async () => {
    const initial = await create();
    for (const input of [
      draft({ title: " " }),
      draft({ title: "x".repeat(201) }),
      draft({ description: "x".repeat(501) }),
      draft({ tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) }),
      draft({ changeNote: "x".repeat(501) }),
      draft({ markdown: "中".repeat(MARKDOWN_LIMITS.sourceBytes) }),
      draft({ markdown: `${"> ".repeat(MARKDOWN_LIMITS.nesting + 1)}deep` }),
    ])
      await expect(
        service.saveDraft(initial.id, initial.version, input),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.saveDraft(initial.id, 0, draft()),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.saveDraft(initial.id, initial.version + 1, draft()),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      service.listRevisions(initial.id, undefined, 51),
    ).rejects.toMatchObject({ status: 400 });
    expect(await service.getAdminTranslation(initial.id)).toEqual(initial);
    expect(await counts(initial.id)).toEqual({
      revisions: 1,
      events: 1,
      search: 0,
      fts: 0,
    });
  });
});
