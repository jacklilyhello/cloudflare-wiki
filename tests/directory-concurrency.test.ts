import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "../shared/auth";
import type { AdminTranslation, DraftInput } from "../shared/content";
import type { Language } from "../shared/contracts";
import type {
  DirectoryMoveCommit,
  DirectoryMovePreview,
} from "../shared/directories";
import { indexSearchText } from "../shared/search";
import type { ContentWriteAccess } from "../worker/auth/access";
import { PageDirectoryService } from "../worker/content/directories";
import {
  getPage,
  getPublishedPages,
  getTranslations,
  searchPages,
} from "../worker/content/public";
import type { ContentService } from "../worker/content/service";
import { getPublicNavigation } from "../worker/navigation/public";
import { NavigationService } from "../worker/navigation/service";
import { RedirectService } from "../worker/redirects/service";
import { contentFixture } from "./content-fixture";

let content: ContentService;
let access: ContentWriteAccess;
let directories: PageDirectoryService;
const draft: DraftInput = {
  title: "Published directory fixture",
  description: "Public description",
  markdown: "Public body needlepublic",
  tags: ["directory"],
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const fixture = await contentFixture(env.DB);
  content = fixture.service;
  access = fixture.access;
  directories = new PageDirectoryService(env.DB, access);
});

afterEach(async () => {
  expect(
    (
      await env.DB.prepare(
        "SELECT language FROM route_registries WHERE move_token IS NOT NULL",
      ).all()
    ).results,
  ).toEqual([]);
});

function page(path: string, language: Language = "en", pageId?: string) {
  return content.createTranslation({ ...draft, path, language, pageId });
}

async function publish(state: AdminTranslation) {
  return content.publish(state.id, state.version, state.draftRevisionId ?? "");
}

async function tree() {
  const parent = await publish(await page("source"));
  const child = await page("source/child");
  const trashed = await page("source/trash");
  const deleted = await content.softDelete(trashed.id, trashed.version);
  return { parent, child, deleted };
}

function commit(preview: DirectoryMovePreview): DirectoryMoveCommit {
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

const stateTables = [
  "pages",
  "page_translations",
  "page_revisions",
  "page_routes",
  "page_events",
  "route_registries",
  "published_search",
  "published_search_fts",
  "navigation_trees",
  "navigation_nodes",
  "audit_records",
];
async function snapshot(includeFts = true) {
  return (
    await env.DB.batch(
      stateTables
        .filter((table) => includeFts || table !== "published_search_fts")
        .map((table) =>
          env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`),
        ),
    )
  ).map((result) => result.results);
}

// Track SQL through bind() without changing D1 execution. Inject only once,
// immediately before the real mutation batch; preflight batches still run.
function beforeMoveBatch(action: () => Promise<unknown>) {
  const tracked = new WeakMap<
    D1PreparedStatement,
    { sql: string; statement: D1PreparedStatement }
  >();
  let calls = 0;
  function track(sql: string, statement: D1PreparedStatement) {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => track(sql, target.bind(...values));
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    tracked.set(proxy, { sql, statement });
    return proxy;
  }
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => track(sql, target.prepare(sql));
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (
            statements.some((statement) =>
              /UPDATE\s+route_registries\s+SET\s+move_token\s*=\s*\?/i.test(
                tracked.get(statement)?.sql ?? "",
              ),
            )
          ) {
            calls++;
            if (calls === 1) await action();
          }
          return target.batch(
            statements.map(
              (statement) => tracked.get(statement)?.statement ?? statement,
            ),
          );
        };
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { service: new PageDirectoryService(db, access), calls: () => calls };
}

describe("directory move races at the D1 batch boundary", () => {
  it.each([
    "create",
    "delete",
    "restore",
    "save",
    "publish",
    "unpublish",
    "move",
  ] as const)(
    "rejects a late %s without undoing the competing mutation",
    async (kind) => {
      const { parent, child, deleted } = await tree();
      const input = commit(
        await directories.preview("en", {
          fromPath: "source",
          toPath: "target",
        }),
      );
      let afterRace: Awaited<ReturnType<typeof snapshot>> | undefined;
      const raced = beforeMoveBatch(async () => {
        if (kind === "create") await page("source/late-child");
        else if (kind === "delete")
          await content.softDelete(child.id, child.version);
        else if (kind === "restore")
          await content.restoreDeleted(deleted.id, deleted.version);
        else if (kind === "save")
          await content.saveDraft(child.id, child.version, {
            ...draft,
            title: "Concurrent draft",
          });
        else if (kind === "publish") await publish(child);
        else if (kind === "unpublish")
          await content.unpublish(parent.id, parent.version);
        else await content.move(child.id, child.version, "outside/child");
        afterRace = await snapshot();
      });
      await expect(raced.service.move("en", input)).rejects.toMatchObject({
        status: 412,
      });
      expect(raced.calls()).toBe(1);
      expect(afterRace).toBeDefined();
      expect(await snapshot()).toEqual(afterRace);
    },
  );

  it("rejects a destination alias created after preview and retains that alias", async () => {
    await tree();
    const other = await page("other-owner");
    const input = commit(
      await directories.preview("en", { fromPath: "source", toPath: "target" }),
    );
    let afterRace: Awaited<ReturnType<typeof snapshot>> | undefined;
    const raced = beforeMoveBatch(async () => {
      const redirects = new RedirectService(env.DB, access);
      await redirects.create("en", {
        expectedVersion: (await redirects.list("en")).version,
        path: "target/alias",
        translationId: other.id,
      });
      afterRace = await snapshot();
    });
    await expect(raced.service.move("en", input)).rejects.toMatchObject({
      status: 412,
    });
    expect(raced.calls()).toBe(1);
    expect(await snapshot()).toEqual(afterRace);
    expect(
      await env.DB.prepare(
        "SELECT translation_id FROM page_routes WHERE language='en' AND path='target/alias'",
      ).first("translation_id"),
    ).toBe(other.id);
  });

  it("allows exactly one simultaneous move from the same preview", async () => {
    const { parent, child, deleted } = await tree();
    const input = commit(
      await directories.preview("en", { fromPath: "source", toPath: "first" }),
    );
    const results = await Promise.allSettled([
      directories.move("en", input),
      directories.move("en", { ...input, toPath: "second" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 412 } });
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled")
      throw new Error("Missing winning move.");
    const prefix = winner.value.toPath;
    const losingPrefix = prefix === "first" ? "second" : "first";
    expect(winner.value.items.map((item) => item.id).sort()).toEqual(
      [parent.id, child.id].sort(),
    );
    expect(await content.getAdminTranslation(parent.id)).toMatchObject({
      path: prefix,
      version: parent.version + 1,
    });
    expect(await content.getAdminTranslation(child.id)).toMatchObject({
      path: `${prefix}/child`,
      version: child.version + 1,
    });
    expect(await content.getAdminTranslation(deleted.id)).toEqual(deleted);
    expect(
      (
        await env.DB.prepare(
          "SELECT path FROM page_routes WHERE path=? OR substr(path,1,length(?)+1)=?||'/'",
        )
          .bind(losingPrefix, losingPrefix, losingPrefix)
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (
        await env.DB.prepare(
          "SELECT translation_id FROM page_events WHERE event_type='move' ORDER BY translation_id",
        ).all<{ translation_id: string }>()
      ).results.map((row) => row.translation_id),
    ).toEqual([parent.id, child.id].sort());
  });

  it("does not let an unrelated language change invalidate the English claim", async () => {
    await tree();
    const input = commit(
      await directories.preview("en", { fromPath: "source", toPath: "target" }),
    );
    const raced = beforeMoveBatch(() => page("source/late", "zh"));
    const result = await raced.service.move("en", input);
    expect(raced.calls()).toBe(1);
    expect(result.items.map((item) => item.path).sort()).toEqual([
      "target",
      "target/child",
    ]);
    expect(
      (await directories.list("zh", { path: "source" })).items.map(
        (item) => item.path,
      ),
    ).toEqual(["source/late"]);
  });
});

describe("directory exact membership and fresh authorization", () => {
  it.each(["omitted", "duplicate", "foreign", "version"] as const)(
    "rejects %s members without changing storage",
    async (kind) => {
      const { parent, child } = await tree();
      const foreign = await page("unrelated");
      const input = commit(
        await directories.preview("en", {
          fromPath: "source",
          toPath: "target",
        }),
      );
      if (kind === "omitted")
        input.expectedMembers = [{ id: parent.id, version: parent.version }];
      else if (kind === "duplicate")
        input.expectedMembers = [
          { id: parent.id, version: parent.version },
          { id: parent.id, version: parent.version },
        ];
      else if (kind === "foreign")
        input.expectedMembers = [
          { id: parent.id, version: parent.version },
          { id: foreign.id, version: foreign.version },
        ];
      else
        input.expectedMembers = [
          { id: parent.id, version: parent.version },
          { id: child.id, version: child.version + 1 },
        ];
      const before = await snapshot();
      await expect(directories.move("en", input)).rejects.toMatchObject({
        status: kind === "duplicate" ? 400 : 412,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "logout",
    "credentials",
    "absolute",
    "idle",
    "session-version",
  ] as const)(
    "rechecks %s invalidation immediately before the claim",
    async (kind) => {
      await tree();
      const input = commit(
        await directories.preview("en", {
          fromPath: "source",
          toPath: "target",
        }),
      );
      let afterRace: Awaited<ReturnType<typeof snapshot>> | undefined;
      const raced = beforeMoveBatch(async () => {
        if (kind === "logout")
          await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?")
            .bind(access.tokenHash)
            .run();
        else if (kind === "credentials")
          await env.DB.prepare(
            "UPDATE administrators SET password_hash='invalid-directory-test-verifier',auth_version=auth_version+1 WHERE id=1",
          ).run();
        else if (kind === "absolute")
          await env.DB.prepare(
            "UPDATE admin_sessions SET created_at=?,expires_at=? WHERE token_hash=?",
          )
            .bind(
              Date.now() - AUTH_LIMITS.absoluteMs,
              Date.now() - 60_000,
              access.tokenHash,
            )
            .run();
        else if (kind === "idle")
          await env.DB.prepare(
            "UPDATE admin_sessions SET created_at=?,last_seen_at=? WHERE token_hash=?",
          )
            .bind(
              Date.now() - AUTH_LIMITS.absoluteMs,
              Date.now() - AUTH_LIMITS.idleMs - 60_000,
              access.tokenHash,
            )
            .run();
        else
          await env.DB.prepare(
            "UPDATE admin_sessions SET auth_version=auth_version+1 WHERE token_hash=?",
          )
            .bind(access.tokenHash)
            .run();
        afterRace = await snapshot();
      });
      await expect(raced.service.move("en", input)).rejects.toMatchObject({
        status: 401,
      });
      expect(raced.calls()).toBe(1);
      expect(await snapshot()).toEqual(afterRace);
    },
  );
});

describe("directory batch rollback", () => {
  it.each([
    "canonical update",
    "page-event insertion",
    "audit insertion",
    "published-search update",
  ] as const)(
    "rolls back inside SQL if %s silently skips one member",
    async (kind) => {
      await tree();
      const input = commit(
        await directories.preview("en", {
          fromPath: "source",
          toPath: "target",
        }),
      );
      const before = await snapshot();
      const condition =
        kind === "canonical update"
          ? "BEFORE UPDATE OF slug ON page_translations WHEN OLD.slug='source/child' AND NEW.slug<>OLD.slug"
          : kind === "page-event insertion"
            ? "BEFORE INSERT ON page_events WHEN NEW.event_type='move' AND NEW.from_path='source/child'"
            : kind === "audit insertion"
              ? "BEFORE INSERT ON audit_records WHEN NEW.action='page.move' AND json_extract(NEW.details_json,'$.fromPath')='source/child'"
              : "BEFORE UPDATE OF path ON published_search WHEN OLD.path='source' AND NEW.path<>OLD.path";
      await env.DB.exec(
        `CREATE TRIGGER directory_fixture_skip ${condition} BEGIN SELECT RAISE(IGNORE); END;`,
      );
      await expect(directories.move("en", input)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["audit", "canonical update"] as const)(
    "rolls back all paths, search, events and its token after a late %s failure",
    async (kind) => {
      const { parent } = await tree();
      const input = commit(
        await directories.preview("en", {
          fromPath: "source",
          toPath: "target",
        }),
      );
      const before = await snapshot();
      if (kind === "audit")
        await env.DB.exec(
          "CREATE TRIGGER directory_fixture_failure BEFORE INSERT ON audit_records WHEN NEW.action='page.move' BEGIN SELECT RAISE(ABORT,'private_directory_audit_failure'); END;",
        );
      else
        await env.DB.exec(
          "CREATE TRIGGER directory_fixture_failure BEFORE UPDATE OF slug ON page_translations WHEN NEW.slug<>OLD.slug BEGIN SELECT RAISE(ABORT,'private_directory_slug_failure'); END;",
        );
      await expect(directories.move("en", input)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await getPage(env.DB, "en", "source")).toMatchObject({
        id: parent.id,
        path: "source",
      });
      expect(await getPage(env.DB, "en", "target")).toBeNull();
      await env.DB.exec("DROP TRIGGER directory_fixture_failure;");
      // A later deliberate request can use the unchanged preview: the failed
      // batch must not leave a claimed registry or consume any member version.
      expect((await directories.move("en", input)).items).toHaveLength(2);
    },
  );

  it("rolls back the claim and route inserts when the FTS table becomes unavailable after preflight", async () => {
    await tree();
    const input = commit(
      await directories.preview("en", { fromPath: "source", toPath: "target" }),
    );
    const before = await snapshot(false);
    const raced = beforeMoveBatch(() =>
      env.DB.exec("DROP TABLE published_search_fts;"),
    );
    await expect(raced.service.move("en", input)).rejects.toThrow();
    expect(raced.calls()).toBe(1);
    expect(await snapshot(false)).toEqual(before);
  });
});

describe("directory publication and cursor compatibility", () => {
  it("preserves draft/publication identity, old aliases, translations and navigation while moving only canonical paths", async () => {
    let parent = await publish(await page("source"));
    const child = await page("source/child");
    const chinese = await publish(await page("中文原文", "zh", parent.pageId));
    parent = await content.saveDraft(parent.id, parent.version, {
      ...draft,
      title: "PRIVATE DRAFT CANARY",
      markdown: "privateneedleonly",
    });
    const redirects = new RedirectService(env.DB, access);
    await redirects.create("en", {
      expectedVersion: (await redirects.list("en")).version,
      path: "historic-manual",
      translationId: parent.id,
    });
    const navigation = new NavigationService(env.DB, access);
    await navigation.save("en", {
      expectedVersion: (await navigation.get("en")).version,
      mode: "custom",
      nodes: [
        {
          id: "directory-public-link",
          parentId: null,
          position: 0,
          kind: "page",
          label: null,
          translationId: parent.id,
          externalUrl: null,
        },
      ],
    });
    const storedNavigation = (
      await env.DB.prepare("SELECT * FROM navigation_nodes ORDER BY id").all()
    ).results;
    const revisions = (
      await env.DB.prepare("SELECT * FROM page_revisions ORDER BY id").all()
    ).results;
    const preview = await directories.preview("en", {
      fromPath: "source",
      toPath: "新目录",
    });
    const result = await directories.move("en", commit(preview));
    expect(result.items.find((item) => item.id === parent.id)).toMatchObject({
      ...parent,
      path: "新目录",
      version: parent.version + 1,
      updatedAt: expect.any(String),
    });
    expect(result.items.find((item) => item.id === child.id)).toMatchObject({
      ...child,
      path: "新目录/child",
      version: child.version + 1,
      updatedAt: expect.any(String),
    });
    expect(
      (await env.DB.prepare("SELECT * FROM page_revisions ORDER BY id").all())
        .results,
    ).toEqual(revisions);
    expect(
      (await env.DB.prepare("SELECT * FROM navigation_nodes ORDER BY id").all())
        .results,
    ).toEqual(storedNavigation);
    const canonical = await getPage(env.DB, "en", "新目录");
    expect(canonical).toMatchObject({
      id: parent.id,
      title: draft.title,
      markdown: draft.markdown,
      updatedAt: parent.publishedAt,
    });
    expect(await getPage(env.DB, "en", "source")).toEqual(canonical);
    expect(await getPage(env.DB, "en", "historic-manual")).toEqual(canonical);
    expect(await getPage(env.DB, "en", "新目录/child")).toBeNull();
    expect(await getPage(env.DB, "en", "source/child")).toBeNull();
    expect(await getTranslations(env.DB, canonical)).toEqual({
      en: "/en/%E6%96%B0%E7%9B%AE%E5%BD%95",
      zh: "/zh/%E4%B8%AD%E6%96%87%E5%8E%9F%E6%96%87",
    });
    expect(await content.getAdminTranslation(chinese.id)).toEqual(chinese);
    expect(await getPublicNavigation(env.DB, "en")).toMatchObject([
      {
        id: "directory-public-link",
        title: draft.title,
        path: "/en/%E6%96%B0%E7%9B%AE%E5%BD%95",
      },
    ]);
    expect(
      (await searchPages(env.DB, "en", "新目录")).map((item) => item.title),
    ).toEqual([draft.title]);
    expect(await searchPages(env.DB, "en", "privateneedleonly")).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT path FROM published_search_fts WHERE translation_id=?",
      )
        .bind(parent.id)
        .first("path"),
    ).toBe(indexSearchText("新目录"));
    const sitemap = await getPublishedPages(env.DB);
    expect(
      sitemap.some((item) => item.language === "en" && item.path === "新目录"),
    ).toBe(true);
    expect(
      sitemap.some((item) => item.language === "en" && item.path === "source"),
    ).toBe(false);
    const events = (
      await env.DB.prepare(
        "SELECT e.translation_id,e.version,e.revision_id,e.from_path,e.to_path,a.details_json FROM page_events e JOIN audit_records a ON a.source_page_event_id=e.id WHERE e.event_type='move' ORDER BY e.translation_id",
      ).all<{
        translation_id: string;
        version: number;
        revision_id: string | null;
        from_path: string;
        to_path: string;
        details_json: string;
      }>()
    ).results;
    expect(events).toHaveLength(2);
    for (const event of events) {
      const original = event.translation_id === parent.id ? parent : child;
      expect(event.version).toBe(original.version + 1);
      expect(event.from_path).toBe(original.path);
      expect(event.to_path).toBe(original.path.replace("source", "新目录"));
      expect(JSON.parse(event.details_json)).toEqual({
        revisionId: event.revision_id,
        fromPath: event.from_path,
        toPath: event.to_path,
      });
    }
  });

  it.each(["delete", "restore"] as const)(
    "invalidates a directory cursor after %s changes active membership",
    async (kind) => {
      const { child, deleted } = await tree();
      await page("source/z-last");
      const first = await directories.list("en", { path: "source", limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      if (kind === "delete") await content.softDelete(child.id, child.version);
      else await content.restoreDeleted(deleted.id, deleted.version);
      await expect(
        directories.list("en", {
          path: "source",
          limit: 1,
          cursor: first.nextCursor ?? "",
        }),
      ).rejects.toMatchObject({ status: 412 });
      expect(
        (await directories.list("en", { path: "source" })).version,
      ).toBeGreaterThan(first.version);
    },
  );
});
