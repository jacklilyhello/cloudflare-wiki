import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_LIMITS } from "../shared/auth";
import type { DraftInput } from "../shared/content";
import * as markdown from "../shared/markdown";
import type { ContentWriteAccess } from "../worker/auth/access";
import { ContentService } from "../worker/content/service";
import { contentFixture } from "./content-fixture";

const input: DraftInput = {
  title: "Private workspace article",
  description: "Draft metadata",
  markdown: "## Draft\n\nPrivate source",
  tags: ["workspace"],
  changeNote: "First version",
};
let service: ContentService;
let access: ContentWriteAccess;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  ({ service, access } = await contentFixture(env.DB));
});
afterEach(() => vi.restoreAllMocks());

function create(overrides: Partial<DraftInput> = {}) {
  return service.createTranslation({
    ...input,
    ...overrides,
    language: "en",
    path: `workspace-${crypto.randomUUID()}`,
  });
}
async function contentSnapshot() {
  const tables = [
    "pages",
    "page_translations",
    "page_revisions",
    "page_routes",
    "page_events",
    "published_search",
    "published_search_fts",
  ];
  return Promise.all(
    tables.map(
      async (table) =>
        (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
          .results,
    ),
  );
}
async function revoke(kind: "logout" | "credentials") {
  if (kind === "logout")
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?")
      .bind(access.tokenHash)
      .run();
  else
    await env.DB.prepare(
      "UPDATE administrators SET password_hash='another-invalid-test-verifier',auth_version=auth_version+1,updated_at=? WHERE id=1",
    )
      .bind(Date.now())
      .run();
}
function revokeBeforeBatch() {
  return new ContentService(
    new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await revoke("logout");
            return target.batch(statements);
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }),
    access,
  );
}

describe("transactional administrator content access", () => {
  it("requires an explicit server session context and rejects a caller's mutable replacement", async () => {
    expect(
      () =>
        new ContentService(env.DB, undefined as unknown as ContentWriteAccess),
    ).toThrow("Authentication required.");
    const supplied = { ...access };
    const copied = new ContentService(env.DB, supplied);
    supplied.tokenHash = "0".repeat(64);
    expect((await copied.list()).items.length).toBeGreaterThan(0);
    const forged = new ContentService(env.DB, {
      ...access,
      authVersion: access.authVersion + 1,
    });
    await expect(
      forged.createTranslation({ ...input, language: "en", path: "forged" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(["logout", "credentials", "absolute", "idle", "version"] as const)(
    "denies private reads and writes after %s invalidation",
    async (kind) => {
      const state = await create();
      if (kind === "logout" || kind === "credentials") await revoke(kind);
      else if (kind === "absolute")
        await env.DB.prepare(
          "UPDATE admin_sessions SET created_at=?,expires_at=? WHERE token_hash=?",
        )
          .bind(
            Date.now() - AUTH_LIMITS.absoluteMs,
            Date.now() - 1,
            access.tokenHash,
          )
          .run();
      else if (kind === "idle")
        await env.DB.prepare(
          "UPDATE admin_sessions SET created_at=?,last_seen_at=? WHERE token_hash=?",
        )
          .bind(
            Date.now() - AUTH_LIMITS.absoluteMs,
            Date.now() - AUTH_LIMITS.idleMs - 1,
            access.tokenHash,
          )
          .run();
      else
        await env.DB.prepare(
          "UPDATE admin_sessions SET auth_version=auth_version+1 WHERE token_hash=?",
        )
          .bind(access.tokenHash)
          .run();
      const before = await contentSnapshot();
      for (const request of [
        () => service.list(),
        () => service.getDetail(state.id),
        () => service.getAdminTranslation(state.id),
        () => service.getRevision(state.id, state.draftRevisionId ?? ""),
        () => service.listRevisions(state.id),
        () => service.listEvents(state.id),
        () => service.saveDraft(state.id, state.version, input),
      ])
        await expect(request()).rejects.toMatchObject({ status: 401 });
      expect(await contentSnapshot()).toEqual(before);
    },
  );

  for (const kind of ["logout", "credentials"] as const) {
    it.each(["create", "save", "restore"] as const)(
      `leaves no content effects when ${kind} occurs during %s Markdown validation`,
      async (operation) => {
        const state = await create();
        const before = await contentSnapshot();
        const render = markdown.renderMarkdown;
        const spy = vi
          .spyOn(markdown, "renderMarkdown")
          .mockImplementation(async (...args) => {
            const rendered = await render(...args);
            await revoke(kind);
            return rendered;
          });
        const request =
          operation === "create"
            ? create()
            : operation === "save"
              ? service.saveDraft(state.id, state.version, input)
              : service.restoreRevision(
                  state.id,
                  state.version,
                  state.draftRevisionId ?? "",
                  "restore fixture",
                );
        await expect(request).rejects.toMatchObject({ status: 401 });
        expect(spy).toHaveBeenCalledOnce();
        expect(await contentSnapshot()).toEqual(before);
      },
    );
  }

  it.each([
    "create",
    "save",
    "publish",
    "unpublish",
    "move",
    "delete",
    "restoreDeleted",
    "restoreRevision",
  ] as const)(
    "guards every %s batch statement after prior checks have passed",
    async (operation) => {
      let state = await create();
      state = await service.publish(
        state.id,
        state.version,
        state.draftRevisionId ?? "",
      );
      if (operation === "restoreDeleted")
        state = await service.softDelete(state.id, state.version);
      const before = await contentSnapshot();
      const guarded = revokeBeforeBatch();
      const actions = {
        create: () =>
          guarded.createTranslation({
            ...input,
            language: "en" as const,
            path: "must-not-leave-orphan",
          }),
        save: () => guarded.saveDraft(state.id, state.version, input),
        publish: () =>
          guarded.publish(state.id, state.version, state.draftRevisionId ?? ""),
        unpublish: () => guarded.unpublish(state.id, state.version),
        move: () =>
          guarded.move(state.id, state.version, "must-not-create-alias"),
        delete: () => guarded.softDelete(state.id, state.version),
        restoreDeleted: () => guarded.restoreDeleted(state.id, state.version),
        restoreRevision: () =>
          guarded.restoreRevision(
            state.id,
            state.version,
            state.draftRevisionId ?? "",
          ),
      };
      await expect(actions[operation]()).rejects.toMatchObject({ status: 401 });
      expect(await contentSnapshot()).toEqual(before);
    },
  );
});

describe("administrator content listing and history", () => {
  it("lists current draft metadata, filters publication states, and returns bilingual detail", async () => {
    const first = await create({ title: "Workspace English" });
    const zh = await service.createTranslation({
      ...input,
      language: "zh",
      pageId: first.pageId,
      path: "workspace-中文",
      title: "Workspace 中文",
    });
    let state = await service.publish(
      first.id,
      first.version,
      first.draftRevisionId ?? "",
    );
    state = await service.saveDraft(first.id, state.version, {
      ...input,
      title: "Workspace changed draft",
      tags: ["changed"],
    });
    const detail = await service.getDetail(first.id);
    expect(detail.draft.title).toBe("Workspace changed draft");
    expect(detail.published?.title).toBe("Workspace English");
    expect(detail.translations.map((item) => item.id)).toEqual([
      first.id,
      zh.id,
    ]);
    const query = { q: "workspace", language: "en" as const };
    expect(
      (await service.list({ ...query, status: "draft" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([state.id]);
    expect(
      (await service.list({ ...query, status: "published" })).items[0],
    ).toMatchObject({
      id: state.id,
      title: "Workspace changed draft",
      tags: ["changed"],
    });
    await service.softDelete(state.id, state.version);
    expect((await service.list(query)).items).toEqual([]);
    expect(
      (await service.list({ ...query, status: "deleted" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([state.id]);
    expect(
      (await service.list({ q: "中文", language: "zh" })).items.map(
        (item) => item.id,
      ),
    ).toEqual([zh.id]);
  });

  it("paginates equal timestamps without duplicates and treats wildcard/query text literally", async () => {
    const states = await Promise.all(
      [
        "Workspace cursor one",
        "Workspace cursor two",
        "Workspace cursor 100%_' OR 1=1 --",
      ].map((title) => create({ title })),
    );
    for (const state of states)
      await env.DB.prepare(
        "UPDATE page_translations SET updated_at=? WHERE id=?",
      )
        .bind("2026-01-01T00:00:00.000Z", state.id)
        .run();
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list({
        q: "workspace cursor",
        limit: 1,
        cursor,
      });
      found.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(states.map((state) => state.id).sort());
    expect(
      (await service.list({ q: "%_' OR 1=1 --" })).items.map((item) => item.id),
    ).toEqual([states[2]?.id]);
    expect(
      (await service.list({ q: "' OR 1=1; DROP TABLE pages; --" })).items,
    ).toEqual([]);
    expect(
      (await service.list({ q: "ＷＯＲＫＳＰＡＣＥ cursor" })).items,
    ).toHaveLength(3);
    for (const options of [
      { limit: 51 },
      { limit: 0 },
      { cursor: "garbage" },
      { cursor: btoa("[]") },
      { q: "x".repeat(201) },
    ])
      await expect(service.list(options)).rejects.toMatchObject({
        status: 400,
      });
  });

  it("paginates immutable events and scopes every revision to its translation", async () => {
    let state = await create();
    const original = state.draftRevisionId ?? "";
    const oldPath = state.path;
    state = await service.saveDraft(state.id, state.version, {
      ...input,
      changeNote: "Second version",
    });
    state = await service.move(state.id, state.version, "workspace-moved");
    const first = await service.listEvents(state.id, { limit: 2 });
    expect(first.items.map((item) => item.type)).toEqual([
      "move",
      "save_draft",
    ]);
    expect(first.items[0]).toMatchObject({
      version: 3,
      fromPath: oldPath,
      toPath: "workspace-moved",
    });
    expect(first.nextCursor).toBe("2");
    const last = await service.listEvents(state.id, {
      cursor: first.nextCursor ?? "",
      limit: 2,
    });
    expect(last.items.map((item) => item.type)).toEqual(["create"]);
    expect(last.nextCursor).toBeNull();
    const other = await create();
    await expect(service.getRevision(other.id, original)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      service.restoreRevision(other.id, other.version, original),
    ).rejects.toMatchObject({ status: 404 });
    for (const cursor of ["0", "-1", "1.5", "1 OR 1=1", "9007199254740992"])
      await expect(
        service.listEvents(state.id, { cursor }),
      ).rejects.toMatchObject({ status: 400 });
  });
});
