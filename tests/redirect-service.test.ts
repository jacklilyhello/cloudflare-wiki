import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "../shared/auth";
import type { Language } from "../shared/contracts";
import type { RedirectListOptions } from "../shared/redirects";
import type { ContentWriteAccess } from "../worker/auth/access";
import { getPage } from "../worker/content/public";
import { ContentService } from "../worker/content/service";
import { RedirectService } from "../worker/redirects/service";
import { contentFixture } from "./content-fixture";

const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
let content: ContentService;
let service: RedirectService;
let access: ContentWriteAccess;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
  const fixture = await contentFixture(env.DB);
  content = fixture.service;
  access = fixture.access;
  service = new RedirectService(env.DB, access);
});
async function page(path = "redirect-target", language: Language = "en") {
  return content.createTranslation({
    language,
    path,
    title: `Title ${path}`,
    description: "",
    markdown: "Private body canary.",
    tags: [],
  });
}
async function registry(language: Language = "en") {
  return (await service.list(language)).version;
}
async function create(
  path: string,
  translationId: string,
  language: Language = "en",
) {
  return service.create(language, {
    expectedVersion: await registry(language),
    path,
    translationId,
  });
}
async function snapshot() {
  const tables = [
    "route_registries",
    "page_routes",
    "page_translations",
    "page_events",
    "published_search",
    "published_search_fts",
    "audit_records",
  ];
  return (
    await env.DB.batch(
      tables.map((table) =>
        env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`),
      ),
    )
  ).map((result) => result.results);
}
async function audit() {
  return (
    await env.DB.prepare(
      "SELECT * FROM audit_records WHERE category='redirect' ORDER BY seq",
    ).all<{
      action: string;
      subject_id: string;
      subject_version: number;
      details_json: string;
    }>()
  ).results;
}
function beforeBatch(action: () => Promise<unknown>): D1Database {
  let done = false;
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await action();
          }
          return target.batch(statements);
        };
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

describe("redirect routes and migration compatibility", () => {
  it("preserves old routes and audit rows, and supports old ContentService INSERTs after migration", async () => {
    await reset();
    const index = migrations.findIndex(
      (migration) => migration.name === "0008_redirects.sql",
    );
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, migrations.slice(0, index));
    const fixture = await contentFixture(env.DB);
    content = fixture.service;
    access = fixture.access;
    const initial = await page();
    const moved = await content.move(
      initial.id,
      initial.version,
      "existing-history",
    );
    const oldAudit = (
      await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all()
    ).results;
    await applyD1Migrations(env.DB, migrations);
    service = new RedirectService(env.DB, access);
    expect(
      (await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all())
        .results,
    ).toEqual(oldAudit);
    const list = await service.list("en");
    expect(list.version).toBe(1);
    expect(list.items).toMatchObject([
      { path: initial.path, origin: "automatic", translationId: initial.id },
    ]);
    const next = await content.move(moved.id, moved.version, "next-history");
    expect(await registry()).toBe(3);
    expect(await audit()).toEqual([]);
    await content.move(next.id, next.version, initial.path);
    expect(await registry()).toBe(4);
  });

  it("creates, renames, retargets and deletes one-hop aliases with exact immutable audit metadata", async () => {
    const first = await page();
    const second = await page("second-target");
    const initialVersion = await registry();
    const added = await service.create("en", {
      expectedVersion: initialVersion,
      path: "extra-entry",
      translationId: first.id,
    });
    expect(added).toMatchObject({
      version: initialVersion + 1,
      item: {
        path: "extra-entry",
        origin: "manual",
        targetPath: first.path,
        targetTitle: `Title ${first.path}`,
        targetStatus: "draft",
      },
    });
    expect(await getPage(env.DB, "en", "extra-entry")).toBeNull();
    const changed = await service.update("en", {
      expectedVersion: added.version,
      sourcePath: "extra-entry",
      path: "renamed-entry",
      translationId: second.id,
    });
    expect(changed.item.translationId).toBe(second.id);
    expect(changed.item.createdAt).toBe(added.item.createdAt);
    await service.delete("en", {
      expectedVersion: changed.version,
      sourcePath: "renamed-entry",
    });
    expect((await service.list("en")).items).toEqual([]);
    const events = await audit();
    expect(
      events.map((entry) => [
        entry.action,
        entry.subject_id,
        entry.subject_version,
      ]),
    ).toEqual([
      ["redirect.create", "en", initialVersion + 1],
      ["redirect.update", "en", initialVersion + 2],
      ["redirect.delete", "en", initialVersion + 3],
    ]);
    expect(events.map((entry) => JSON.parse(entry.details_json))).toEqual([
      {
        sourcePath: "extra-entry",
        previousPath: null,
        targetTranslationId: first.id,
        previousTarget: null,
      },
      {
        sourcePath: "renamed-entry",
        previousPath: "extra-entry",
        targetTranslationId: second.id,
        previousTarget: first.id,
      },
      {
        sourcePath: null,
        previousPath: "renamed-entry",
        targetTranslationId: null,
        previousTarget: second.id,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("Private body canary");
  });

  it("edits and deletes automatic aliases without changing their creation origin or page history", async () => {
    const first = await page();
    const moved = await content.move(first.id, first.version, "moved-target");
    const beforeEvents = (
      await env.DB.prepare("SELECT * FROM page_events ORDER BY id").all()
    ).results;
    const changed = await service.update("en", {
      expectedVersion: await registry(),
      sourcePath: first.path,
      path: "edited-history",
      translationId: moved.id,
    });
    expect(changed.item.origin).toBe("automatic");
    await service.delete("en", {
      expectedVersion: changed.version,
      sourcePath: changed.item.path,
    });
    expect(
      (await env.DB.prepare("SELECT * FROM page_events ORDER BY id").all())
        .results,
    ).toEqual(beforeEvents);
    expect((await audit()).map((row) => row.action)).toEqual([
      "redirect.update",
      "redirect.delete",
    ]);
    expect((await service.list("en")).items).toEqual([]);
  });

  it("keeps canonical paths protected in SQL for manual origins and deleted pages", async () => {
    const target = await page();
    await create("promoted", target.id);
    const moved = await content.move(target.id, target.version, "promoted");
    const deleted = await content.softDelete(moved.id, moved.version);
    expect(
      (await service.list("en")).items.map((item) => item.path),
    ).not.toContain("promoted");
    const before = await snapshot();
    await expect(
      service.delete("en", {
        expectedVersion: await registry(),
        sourcePath: "promoted",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.update("en", {
        expectedVersion: await registry(),
        sourcePath: "promoted",
        path: "illegal-change",
        translationId: deleted.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      env.DB.prepare(
        "DELETE FROM page_routes WHERE language='en' AND path='promoted'",
      ).run(),
    ).rejects.toThrow("redirect_canonical");
    await expect(
      env.DB.prepare(
        "UPDATE page_routes SET path='illegal-change' WHERE language='en' AND path='promoted'",
      ).run(),
    ).rejects.toThrow("redirect_canonical");
    expect(await snapshot()).toEqual(before);
  });

  it("rejects occupied paths, cross-language and deleted targets without partial writes", async () => {
    const first = await page();
    const chinese = await page("中文目标", "zh");
    const removed = await page("deleted-target");
    await content.softDelete(removed.id, removed.version);
    await create("occupied-alias", first.id);
    const before = await snapshot();
    const expectedVersion = await registry();
    for (const [path, translationId, status] of [
      [first.path, first.id, 409],
      ["occupied-alias", first.id, 409],
      ["cross-language", chinese.id, 400],
      ["deleted-entry", removed.id, 409],
      ["missing-entry", "missing", 404],
    ] as const)
      await expect(
        service.create("en", { expectedVersion, path, translationId }),
      ).rejects.toMatchObject({ status });
    await expect(
      service.delete("en", { expectedVersion, sourcePath: "missing" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps redirects bound to current publication and never exposes drafts after move/delete/restore", async () => {
    let target = await page();
    const first = await create("public-alias", target.id);
    target = await content.publish(
      target.id,
      target.version,
      target.draftRevisionId ?? "",
    );
    expect((await getPage(env.DB, "en", first.item.path))?.path).toBe(
      target.path,
    );
    target = await content.move(target.id, target.version, "latest-target");
    expect((await getPage(env.DB, "en", first.item.path))?.path).toBe(
      "latest-target",
    );
    target = await content.softDelete(target.id, target.version);
    expect(await getPage(env.DB, "en", first.item.path)).toBeNull();
    expect(
      (await service.list("en", { sourcePath: first.item.path })).items[0]
        ?.targetStatus,
    ).toBe("deleted");
    target = await content.restoreDeleted(target.id, target.version);
    expect(await getPage(env.DB, "en", first.item.path)).toBeNull();
    expect(
      (await service.list("en", { sourcePath: first.item.path })).items[0]
        ?.targetStatus,
    ).toBe("draft");
    await content.publish(
      target.id,
      target.version,
      target.draftRevisionId ?? "",
    );
    expect(
      (await service.list("en", { sourcePath: first.item.path })).items[0]
        ?.targetStatus,
    ).toBe("published");
  });

  it("treats an unchanged update as a successful no-op without adding audit events", async () => {
    const target = await page();
    const added = await create("unchanged", target.id);
    const before = await snapshot();
    expect(
      (
        await service.update("en", {
          expectedVersion: added.version,
          sourcePath: added.item.path,
          path: added.item.path,
          translationId: target.id,
        })
      ).version,
    ).toBe(added.version);
    expect(await snapshot()).toEqual(before);
  });
});

describe("registry CAS and transaction races", () => {
  it("lets exactly one same-language writer win while independent languages remain writable", async () => {
    const target = await page();
    const chinese = await page("中文目标", "zh");
    const en = await registry();
    const zh = await registry("zh");
    const results = await Promise.allSettled([
      service.create("en", {
        expectedVersion: en,
        path: "first-writer",
        translationId: target.id,
      }),
      service.create("en", {
        expectedVersion: en,
        path: "second-writer",
        translationId: target.id,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 412 } });
    expect((await audit()).length).toBe(1);
    expect(
      (
        await service.create("zh", {
          expectedVersion: zh,
          path: "别名",
          translationId: chinese.id,
        })
      ).version,
    ).toBe(zh + 1);
  });

  it("returns each mutation's registry version from the same batch snapshot", async () => {
    const target = await page();
    let injected = false;
    const db = new Proxy(env.DB, {
      get(real, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await real.batch(statements);
            if (!injected) {
              injected = true;
              await create("later-alias", target.id);
            }
            return result;
          };
        const member = Reflect.get(real, key, real);
        return typeof member === "function" ? member.bind(real) : member;
      },
    });
    const before = await registry();
    const first = await new RedirectService(db, access).create("en", {
      expectedVersion: before,
      path: "first-alias",
      translationId: target.id,
    });
    expect(first.version).toBe(before + 1);
    expect(await registry()).toBe(before + 2);
  });

  it("invalidates an alias editor when ContentService moves onto that existing alias", async () => {
    const target = await page();
    const added = await create("promoted-alias", target.id);
    const raced = new RedirectService(
      beforeBatch(() =>
        content.move(target.id, target.version, "promoted-alias"),
      ),
      access,
    );
    await expect(
      raced.delete("en", {
        expectedVersion: added.version,
        sourcePath: added.item.path,
      }),
    ).rejects.toMatchObject({ status: 412 });
    expect(
      await env.DB.prepare("SELECT slug FROM page_translations WHERE id=?")
        .bind(target.id)
        .first("slug"),
    ).toBe("promoted-alias");
    expect((await audit()).map((row) => row.action)).toEqual([
      "redirect.create",
    ]);
  });

  it("rolls back a page move when another writer has retargeted the intended alias", async () => {
    const first = await page();
    const second = await page("other-target");
    const added = await create("claimed-alias", first.id);
    const raced = new ContentService(
      beforeBatch(() =>
        service.update("en", {
          expectedVersion: added.version,
          sourcePath: added.item.path,
          path: added.item.path,
          translationId: second.id,
        }),
      ),
      access,
    );
    await expect(
      raced.move(first.id, first.version, added.item.path),
    ).rejects.toMatchObject({ status: 409 });
    expect((await content.getAdminTranslation(first.id)).path).toBe(first.path);
    expect(
      (await service.list("en", { sourcePath: added.item.path })).items[0]
        ?.translationId,
    ).toBe(second.id);
  });

  it("allows a move to recreate an alias whose deletion won first without losing canonical ownership", async () => {
    const target = await page();
    const added = await create("recreated-by-move", target.id);
    const raced = new ContentService(
      beforeBatch(() =>
        service.delete("en", {
          expectedVersion: added.version,
          sourcePath: added.item.path,
        }),
      ),
      access,
    );
    const moved = await raced.move(target.id, target.version, added.item.path);
    expect(moved.path).toBe(added.item.path);
    expect(
      await env.DB.prepare(
        "SELECT origin FROM page_routes WHERE language='en' AND path=?",
      )
        .bind(added.item.path)
        .first("origin"),
    ).toBe("automatic");
    expect(
      (await service.list("en", { sourcePath: added.item.path })).items,
    ).toEqual([]);
  });

  it("prevents stale delete/recreate ABA requests from changing a new target", async () => {
    const first = await page();
    const second = await page("replacement-target");
    const original = await create("reused-path", first.id);
    const deleted = await service.delete("en", {
      expectedVersion: original.version,
      sourcePath: original.item.path,
    });
    await service.create("en", {
      expectedVersion: deleted.version,
      path: original.item.path,
      translationId: second.id,
    });
    await expect(
      service.delete("en", {
        expectedVersion: original.version,
        sourcePath: original.item.path,
      }),
    ).rejects.toMatchObject({ status: 412 });
    expect(
      (await service.list("en", { sourcePath: original.item.path })).items[0]
        ?.translationId,
    ).toBe(second.id);
  });

  it("rejects a stale redirect write when target deletion advances the directory registry", async () => {
    const target = await page();
    const expectedVersion = await registry();
    const raced = new RedirectService(
      beforeBatch(() => content.softDelete(target.id, target.version)),
      access,
    );
    await expect(
      raced.create("en", {
        expectedVersion,
        path: "must-not-exist",
        translationId: target.id,
      }),
    ).rejects.toMatchObject({ status: 412 });
    expect(await registry()).toBe(expectedVersion + 1);
    expect(await audit()).toEqual([]);
  });

  it.each(["create", "update", "delete"] as const)(
    "rolls back route and registry changes when %s audit insertion fails",
    async (operation) => {
      const target = await page();
      const added = await create("before-failure", target.id);
      const before = await snapshot();
      await env.DB.exec(
        "CREATE TRIGGER redirect_fixture_failure BEFORE INSERT ON audit_records WHEN NEW.category='redirect' BEGIN SELECT RAISE(ABORT,'private_audit_failure'); END;",
      );
      const write =
        operation === "create"
          ? service.create("en", {
              expectedVersion: added.version,
              path: "new-entry",
              translationId: target.id,
            })
          : operation === "update"
            ? service.update("en", {
                expectedVersion: added.version,
                sourcePath: added.item.path,
                path: "changed-entry",
                translationId: target.id,
              })
            : service.delete("en", {
                expectedVersion: added.version,
                sourcePath: added.item.path,
              });
      await expect(write).rejects.toMatchObject({
        status: 503,
        message: "Redirect storage is temporarily unavailable.",
      });
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("private reads, input bounds and Unicode pagination", () => {
  it("fails closed on canonical destinations even if their route is missing", async () => {
    const target = await page();
    const added = await create("existing-alias", target.id);
    // A deliberately incomplete local fixture exercises the independent slug
    // guard, rather than relying on the normal route primary-key collision.
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO page_translations(id,page_id,language,slug,created_at,updated_at) VALUES('route-less-translation',?,'zh','reserved-without-route',?,?)",
    )
      .bind(target.pageId, now, now)
      .run();
    const chinese = await page("valid-chinese-target", "zh");
    const zhAlias = await create("editable-alias", chinese.id, "zh");
    const before = await snapshot();
    await expect(
      service.create("zh", {
        expectedVersion: zhAlias.version,
        path: "reserved-without-route",
        translationId: chinese.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.update("zh", {
        expectedVersion: zhAlias.version,
        sourcePath: zhAlias.item.path,
        path: "reserved-without-route",
        translationId: chinese.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(before);
    expect(added.item.path).toBe("existing-alias");
  });

  it("maps preparation failures to a generic 503 for reads and writes", async () => {
    const target = await page();
    const expectedVersion = await registry();
    const db = new Proxy(env.DB, {
      get(real, key) {
        if (key === "prepare")
          return () => {
            throw new Error("private-sql-and-credential-canary");
          };
        const member = Reflect.get(real, key, real);
        return typeof member === "function" ? member.bind(real) : member;
      },
    });
    const failed = new RedirectService(db, access);
    await expect(failed.list("en")).rejects.toMatchObject({
      status: 503,
      message: "Redirect storage is temporarily unavailable.",
    });
    await expect(
      failed.create("en", {
        expectedVersion,
        path: "new-entry",
        translationId: target.id,
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "Redirect storage is temporarily unavailable.",
    });
  });

  it("paginates Unicode paths with filter-bound cursors and invalidates them after any registry change", async () => {
    const target = await page("中文目标", "zh");
    await env.DB.batch(
      Array.from({ length: 57 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO page_routes(language,path,translation_id,created_at) VALUES('zh',?,?,?)",
        ).bind(
          `目录/项目${String(index).padStart(3, "0")}`,
          target.id,
          new Date().toISOString(),
        ),
      ),
    );
    const first = await service.list("zh", {
      q: "目录",
      origin: "automatic",
      translationId: target.id,
    });
    expect(first.items).toHaveLength(25);
    const second = await service.list("zh", {
      q: "目录",
      origin: "automatic",
      translationId: target.id,
      cursor: first.nextCursor ?? "",
      limit: 50,
    });
    expect(second.items).toHaveLength(32);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.path)).size,
    ).toBe(57);
    expect(second.nextCursor).toBeNull();
    const exact = await service.list("zh", { sourcePath: "目录/项目001" });
    expect(exact.items).toHaveLength(1);
    for (const scope of [
      { q: "项目" },
      { origin: "manual" },
      { translationId: "different" },
      { sourcePath: "目录/项目001" },
    ])
      await expect(
        service.list("zh", {
          q: "目录",
          origin: "automatic",
          translationId: target.id,
          ...scope,
          cursor: first.nextCursor ?? "",
        } as RedirectListOptions),
      ).rejects.toMatchObject({ status: 400 });
    await create("额外路径", target.id, "zh");
    await expect(
      service.list("zh", {
        q: "目录",
        origin: "automatic",
        translationId: target.id,
        cursor: first.nextCursor ?? "",
      }),
    ).rejects.toMatchObject({ status: 412 });
  });

  it.each(["logout", "credentials", "absolute", "idle"] as const)(
    "rejects populated and empty private reads after %s",
    async (kind) => {
      const target = await page();
      await create("private-alias", target.id);
      if (kind === "logout")
        await env.DB.prepare("DELETE FROM admin_sessions").run();
      else if (kind === "credentials")
        await env.DB.prepare(
          "UPDATE administrators SET auth_version=auth_version+1 WHERE id=1",
        ).run();
      else
        await env.DB.prepare(
          "UPDATE admin_sessions SET created_at=?,expires_at=?,last_seen_at=?",
        )
          .bind(
            Date.now() - AUTH_LIMITS.absoluteMs - 2000,
            kind === "absolute" ? Date.now() - 1000 : Date.now() + 60_000,
            kind === "idle"
              ? Date.now() - AUTH_LIMITS.idleMs - 1000
              : Date.now() - 1000,
          )
          .run();
      await expect(service.list("en")).rejects.toMatchObject({ status: 401 });
      await expect(
        service.list("en", { sourcePath: "missing" }),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it.each(["create", "update", "delete"] as const)(
    "leaves no side effects when the session is revoked immediately before %s",
    async (operation) => {
      const target = await page();
      const added = await create("existing-entry", target.id);
      const before = await snapshot();
      const raced = new RedirectService(
        beforeBatch(() => env.DB.prepare("DELETE FROM admin_sessions").run()),
        access,
      );
      const request =
        operation === "create"
          ? raced.create("en", {
              expectedVersion: added.version,
              path: "new-entry",
              translationId: target.id,
            })
          : operation === "update"
            ? raced.update("en", {
                expectedVersion: added.version,
                sourcePath: added.item.path,
                path: "changed-entry",
                translationId: target.id,
              })
            : raced.delete("en", {
                expectedVersion: added.version,
                sourcePath: added.item.path,
              });
      await expect(request).rejects.toMatchObject({ status: 401 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("rejects unsafe source paths and malformed filters without weakening the existing path contract", async () => {
    const target = await page();
    const expectedVersion = await registry();
    const before = await snapshot();
    for (const path of [
      "https://example.com",
      "//outside",
      "%2fadmin",
      "../x",
      "x\\y",
      "api/hidden",
      "search",
      "UPPER",
      "ｆｏｏ",
      "x\ny",
      "x".repeat(241),
      "",
    ])
      await expect(
        service.create("en", {
          expectedVersion,
          path,
          translationId: target.id,
        }),
      ).rejects.toMatchObject({ status: 400 });
    for (const options of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { q: "x".repeat(201) },
      { origin: "external" },
      { sourcePath: "../x" },
      { translationId: "' OR 1=1 --" },
      { cursor: "" },
      { cursor: "x".repeat(4097) },
      { cursor: "not+base64" },
      { unexpected: true },
    ])
      await expect(
        service.list("en", options as RedirectListOptions),
      ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it("supports the maximum Chinese source paths within the closed 2 KiB audit metadata bound", async () => {
    const target = await page("中文目标", "zh");
    const first = await create("旧".repeat(240), target.id, "zh");
    const next = await service.update("zh", {
      expectedVersion: first.version,
      sourcePath: first.item.path,
      path: "新".repeat(240),
      translationId: target.id,
    });
    expect(
      (await service.list("zh", { sourcePath: next.item.path })).items,
    ).toHaveLength(1);
    const event = (await audit()).at(-1);
    expect(
      new TextEncoder().encode(event?.details_json ?? "").length,
    ).toBeLessThanOrEqual(2048);
    for (const details of [
      {
        sourcePath: "x",
        previousPath: null,
        targetTranslationId: target.id,
        previousTarget: null,
        password: "extra-field",
      },
      {
        sourcePath: "x",
        previousPath: "not-null",
        targetTranslationId: target.id,
        previousTarget: null,
      },
    ])
      await expect(
        env.DB.prepare(
          "INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at) VALUES('redirect','zh',1,'redirect.create','zh','current',?,?)",
        )
          .bind(JSON.stringify(details), new Date().toISOString())
          .run(),
      ).rejects.toThrow("audit_invalid");
  });
});
