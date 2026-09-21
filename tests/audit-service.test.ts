import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditListOptions, AuditRecord } from "../shared/audit";
import { AUTH_LIMITS } from "../shared/auth";
import { AuditError, AuditService } from "../worker/audit/service";
import type { ContentWriteAccess } from "../worker/auth/access";
import type { ContentService } from "../worker/content/service";
import { contentFixture } from "./content-fixture";

const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
let access: ContentWriteAccess;
let content: ContentService;
let service: AuditService;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
  const fixture = await contentFixture(env.DB);
  access = fixture.access;
  content = fixture.service;
  service = new AuditService(env.DB, access);
});

const initialDraft = {
  title: "Original event title",
  description: "Description is not audit metadata",
  markdown: "A source body is stored only in revisions.",
  tags: ["original"],
  changeNote: "A change note remains in the page history.",
};
async function page() {
  return content.createTranslation({
    ...initialDraft,
    language: "en",
    path: `audit-${crypto.randomUUID()}`,
  });
}
async function navigationEvent(
  timestamp = "2026-09-21T03:00:00.000Z",
  language = "en",
) {
  await env.DB.prepare(
    "UPDATE navigation_trees SET version=version+1,mode='custom',updated_at=? WHERE language=?",
  )
    .bind(timestamp, language)
    .run();
}
async function snapshot() {
  return (
    await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all()
  ).results;
}
function cursorValue(value: unknown) {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
async function all(options: AuditListOptions = {}) {
  const records: AuditRecord[] = [];
  let cursor: string | undefined;
  do {
    const result = await service.list({ ...options, cursor, limit: 50 });
    records.push(...result.items);
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return records;
}

describe("audit migration and schema", () => {
  it("backfills existing events once as legacy with their original time and revision, then projects only new events as current", async () => {
    await reset();
    const auditIndex = migrations.findIndex(
      (migration) => migration.name === "0007_audit.sql",
    );
    expect(auditIndex).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, migrations.slice(0, auditIndex));
    const fixture = await contentFixture(env.DB);
    access = fixture.access;
    content = fixture.service;
    const old = await page();
    const previous = (
      await env.DB.prepare(
        "SELECT id,translation_id,version,event_type,revision_id,from_path,to_path,created_at FROM page_events ORDER BY created_at,id",
      ).all<{
        id: string;
        translation_id: string;
        version: number;
        event_type: string;
        revision_id: string | null;
        from_path: string | null;
        to_path: string | null;
        created_at: string;
      }>()
    ).results;
    await applyD1Migrations(env.DB, migrations);
    const migrated = await snapshot();
    expect(migrated).toHaveLength(previous.length);
    for (const [index, event] of previous.entries()) {
      expect(migrated[index]).toMatchObject({
        seq: index + 1,
        category: "page",
        subject_id: event.translation_id,
        subject_version: event.version,
        action: `page.${event.event_type}`,
        source_page_event_id: event.id,
        origin: "legacy",
        created_at: event.created_at,
        details_json: JSON.stringify({
          revisionId: event.revision_id,
          fromPath: event.from_path,
          toPath: event.to_path,
        }),
      });
    }
    await applyD1Migrations(env.DB, migrations);
    expect(await snapshot()).toEqual(migrated);
    service = new AuditService(env.DB, access);
    await content.saveDraft(old.id, old.version, {
      ...initialDraft,
      title: "Later draft title",
    });
    const records = await all({ subjectId: old.id });
    expect(
      records.map((record) => [record.action, record.origin, record.pageTitle]),
    ).toEqual([
      ["page.save_draft", "current", "Later draft title"],
      ["page.create", "legacy", "Original event title"],
    ]);
    // The already existing administrator is not given an invented initialization event.
    expect((await service.list({ category: "administrator" })).items).toEqual(
      [],
    );
  });

  it("prevents updates and deletes and rejects duplicate source events", async () => {
    const before = await snapshot();
    await expect(
      env.DB.prepare("UPDATE audit_records SET created_at='changed'").run(),
    ).rejects.toThrow("audit_immutable");
    await expect(
      env.DB.prepare("DELETE FROM audit_records").run(),
    ).rejects.toThrow("audit_immutable");
    await expect(
      env.DB.prepare(`INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,source_page_event_id,details_json,created_at)
      SELECT category,subject_id,subject_version,action,language,origin,source_page_event_id,details_json,created_at FROM audit_records WHERE category='page' LIMIT 1`).run(),
    ).rejects.toThrow("UNIQUE");
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ usernameChanged: true }),
    JSON.stringify({ usernameChanged: "true", passwordChanged: false }),
    JSON.stringify({
      usernameChanged: true,
      passwordChanged: false,
      password: "must not be a stored field",
    }),
    JSON.stringify({
      usernameChanged: true,
      passwordChanged: false,
      padding: "x".repeat(2048),
    }),
  ])(
    "rejects malformed or non-allowlisted administrator details: %s",
    async (details) => {
      const before = await snapshot();
      await expect(
        env.DB.prepare(`INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
      VALUES('administrator','1',2,'administrator.credentials',NULL,'current',?,'2026-09-21T00:00:00.000Z')`)
          .bind(details)
          .run(),
      ).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    },
  );

  it("requires each category's action, language and bounded metadata shape", async () => {
    const before = await snapshot();
    for (const [action, language, subject, details] of [
      [
        "page.create",
        "en",
        "en",
        { previousMode: "automatic", mode: "custom", nodeCount: 0 },
      ],
      [
        "navigation.save",
        null,
        "en",
        { previousMode: "automatic", mode: "custom", nodeCount: 0 },
      ],
      [
        "navigation.save",
        "en",
        "zh",
        { previousMode: "automatic", mode: "custom", nodeCount: 0 },
      ],
      [
        "navigation.save",
        "en",
        "en",
        { previousMode: "automatic", mode: "custom", nodeCount: 301 },
      ],
      [
        "navigation.save",
        "en",
        "en",
        { previousMode: "automatic", mode: "custom", nodeCount: 0, nodes: [] },
      ],
    ] as const) {
      await expect(
        env.DB.prepare(`INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
        VALUES('navigation',?,2,?,?,'current',?,'2026-09-21T00:00:00.000Z')`)
          .bind(subject, action, language, JSON.stringify(details))
          .run(),
      ).rejects.toThrow();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rejects future categories until a reviewed migration extends the insert validator", async () => {
    const before = await snapshot();
    for (const category of ["asset", "redirect", "settings"])
      await expect(
        env.DB.prepare(`INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at)
          VALUES(?,'fixture',1,?,NULL,'current','{}','2026-09-21T00:00:00.000Z')`)
          .bind(category, `${category}.create`)
          .run(),
      ).rejects.toThrow("audit_invalid");
    expect(await snapshot()).toEqual(before);
  });
});

describe("audit reads", () => {
  it("reads page titles only from the event's owned immutable revision and omits unavailable titles", async () => {
    let state = await page();
    const originalRevision = state.draftRevisionId;
    state = await content.saveDraft(state.id, state.version, {
      ...initialDraft,
      title: "Current draft title",
    });
    state = await content.move(state.id, state.version, "audit-current-path");
    const records = await all({ subjectId: state.id });
    expect(records.map((record) => [record.action, record.pageTitle])).toEqual([
      ["page.move", null],
      ["page.save_draft", "Current draft title"],
      ["page.create", "Original event title"],
    ]);
    expect(records[2]).toMatchObject({
      category: "page",
      language: "en",
      origin: "current",
      details: { revisionId: originalRevision, fromPath: null },
    });
    expect(records[0]).toMatchObject({
      details: { revisionId: null, toPath: "audit-current-path" },
    });
    expect(Object.keys(records[2]?.details ?? {})).toEqual([
      "revisionId",
      "fromPath",
      "toPath",
    ]);
  });

  it("paginates same-timestamp records without duplicates while new records arrive", async () => {
    for (let index = 0; index < 5; index++) await navigationEvent();
    const expected = (await all({ category: "navigation" })).map(
      (record) => record.seq,
    );
    const first = await service.list({ category: "navigation", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    await navigationEvent();
    const second = await service.list({
      category: "navigation",
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    const third = await service.list({
      category: "navigation",
      limit: 2,
      cursor: second.nextCursor ?? "",
    });
    const paged = [...first.items, ...second.items, ...third.items];
    expect(paged.map((record) => record.seq)).toEqual(expected);
    expect(new Set(paged.map((record) => record.createdAt)).size).toBe(1);
    expect(third.nextCursor).toBeNull();
    expect(
      (await service.list({ category: "navigation", limit: 1 })).items[0]?.seq,
    ).toBeGreaterThan(expected[0] ?? 0);
  });

  it("defaults to 25, caps at 50 and permits a page-size change without changing cursor scope", async () => {
    await env.DB.batch(
      Array.from({ length: 60 }, () =>
        env.DB.prepare(
          "UPDATE navigation_trees SET version=version+1 WHERE language='en'",
        ),
      ),
    );
    const first = await service.list({ category: "navigation" });
    expect(first.items).toHaveLength(25);
    const second = await service.list({
      category: "navigation",
      cursor: first.nextCursor ?? "",
      limit: 50,
    });
    expect(second.items).toHaveLength(35);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((record) => record.seq))
        .size,
    ).toBe(60);
  });

  it("combines category/action/language/subject/time filters with inclusive from and exclusive to", async () => {
    await navigationEvent("2026-09-21T01:00:00.000Z", "en");
    await navigationEvent("2026-09-21T02:00:00.000Z", "en");
    await navigationEvent("2026-09-21T03:00:00.000Z", "en");
    await navigationEvent("2026-09-21T02:00:00.000Z", "zh");
    const result = await service.list({
      category: "navigation",
      action: "navigation.save",
      language: "en",
      subjectId: "en",
      from: "2026-09-21T02:00:00.000Z",
      to: "2026-09-21T03:00:00.000Z",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      category: "navigation",
      language: "en",
      subjectId: "en",
      createdAt: "2026-09-21T02:00:00.000Z",
      details: { previousMode: "custom", mode: "custom", nodeCount: 0 },
      pageTitle: null,
    });
    const site = await service.list({ language: "site" });
    expect(site.items).toHaveLength(1);
    expect(site.items[0]).toMatchObject({
      category: "administrator",
      language: null,
      action: "administrator.initialize",
      details: null,
      pageTitle: null,
    });
    expect(
      (await service.list({ category: "page", language: "site" })).items,
    ).toEqual([]);
    expect((await service.list({ subjectId: "absent" })).items).toEqual([]);
  });

  it("binds cursor scope to every normalized filter", async () => {
    const base: AuditListOptions = {
      category: "navigation",
      action: "navigation.save",
      language: "en",
      subjectId: "en",
      from: "2026-09-21T00:00:00.000Z",
      to: "2026-09-22T00:00:00.000Z",
      limit: 1,
    };
    await navigationEvent();
    await navigationEvent();
    const first = await service.list(base);
    expect(first.nextCursor).not.toBeNull();
    for (const altered of [
      { category: undefined },
      { action: undefined },
      { language: "zh" },
      { subjectId: "zh" },
      { from: "2026-09-20T00:00:00.000Z" },
      { to: "2026-09-23T00:00:00.000Z" },
    ] satisfies Partial<AuditListOptions>[]) {
      await expect(
        service.list({ ...base, ...altered, cursor: first.nextCursor ?? "" }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(
      (await service.list({ ...base, cursor: first.nextCursor ?? "" })).items,
    ).toHaveLength(1);
  });

  it("rejects malformed, noncanonical and structurally tampered cursors", async () => {
    const valid = (await service.list({ limit: 1 })).nextCursor;
    expect(valid).not.toBeNull();
    const decoded = JSON.parse(
      atob((valid ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    );
    for (const cursor of [
      "",
      "?",
      "a".repeat(2049),
      `${valid}=`,
      cursorValue(null),
      cursorValue([]),
      cursorValue({}),
      cursorValue({ ...decoded, before: -1 }),
      cursorValue({ ...decoded, before: 0.5 }),
      cursorValue({ ...decoded, before: Number.MAX_SAFE_INTEGER + 1 }),
      cursorValue({ ...decoded, v: 2 }),
      cursorValue({ ...decoded, extra: "unexpected" }),
      cursorValue({
        ...decoded,
        filters: { ...decoded.filters, subjectId: "' OR 1=1 --" },
      }),
    ])
      await expect(service.list({ cursor })).rejects.toMatchObject({
        status: 400,
      });
  });

  it.each([
    { category: "assets" },
    { action: "page.inject" },
    { category: "page", action: "navigation.save" },
    { language: "fr" },
    { subjectId: "" },
    { subjectId: "x".repeat(129) },
    { subjectId: "' OR 1=1 --" },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: "25" },
    { from: "2026-02-30T00:00:00.000Z" },
    { from: "2026-09-21" },
    { from: "2026-09-21T00:00:00Z" },
    { from: "2026-09-21T00:00:00.000+00:00" },
    { from: "2026-09-21T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" },
    { from: "2026-09-22T00:00:00.000Z", to: "2026-09-21T00:00:00.000Z" },
    { unknown: "field" },
  ])("rejects invalid filter input %j", async (options) => {
    await expect(
      service.list(options as AuditListOptions),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not bind a requested SQL fragment as an identifier or expression", async () => {
    expect(
      (await service.list({ subjectId: "page:unused_id-1" })).items,
    ).toEqual([]);
    await expect(
      service.list({
        action: "page.create' OR 1=1 --" as AuditListOptions["action"],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("audit read authorization and errors", () => {
  it("requires explicit well-formed server access and rejects an incorrect credential version", async () => {
    expect(
      () =>
        new AuditService(env.DB, undefined as unknown as ContentWriteAccess),
    ).toThrow("Authentication required.");
    expect(
      () =>
        new AuditService(env.DB, { tokenHash: "not-a-hash", authVersion: 1 }),
    ).toThrow("Authentication required.");
    await expect(
      new AuditService(env.DB, {
        ...access,
        authVersion: access.authVersion + 1,
      }).list(),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(["logout", "credentials", "absolute", "idle"] as const)(
    "checks the live session on reads after %s, including empty filters",
    async (kind) => {
      const now = Date.now();
      if (kind === "logout")
        await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?")
          .bind(access.tokenHash)
          .run();
      else if (kind === "credentials")
        await env.DB.prepare(
          "UPDATE administrators SET auth_version=auth_version+1 WHERE id=1",
        ).run();
      else
        await env.DB.prepare(
          "UPDATE admin_sessions SET created_at=?,expires_at=?,last_seen_at=? WHERE token_hash=?",
        )
          .bind(
            now - AUTH_LIMITS.absoluteMs - 1000,
            kind === "absolute" ? now - 1000 : now + 1000,
            kind === "idle" ? now - AUTH_LIMITS.idleMs - 1000 : now - 1000,
            access.tokenHash,
          )
          .run();
      await expect(service.list()).rejects.toMatchObject({ status: 401 });
      await expect(
        service.list({ subjectId: "missing" }),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it("maps database failures to a generic 503 without leaking the underlying error", async () => {
    const failed = new AuditService(
      new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare")
            return () => {
              throw new Error("private-storage-error-canary");
            };
          const member = Reflect.get(target, key, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      }),
      access,
    );
    await expect(failed.list()).rejects.toEqual(
      new AuditError(503, "Audit storage is temporarily unavailable."),
    );
  });
});
