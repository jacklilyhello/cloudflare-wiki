import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, type AuditPage } from "../shared/audit";
import {
  FILE_ACTIONS,
  FILE_FIELDS,
  type FileAction,
  type FileField,
} from "../shared/files";
import { INITIAL_SITE_SETTINGS } from "../shared/settings";
import { adminApi } from "../worker/admin";
import { AuditError, AuditService } from "../worker/audit/service";
import type { ContentWriteAccess } from "../worker/auth/access";
import { ContentService } from "../worker/content/service";
import { NavigationService } from "../worker/navigation/service";
import { RedirectService } from "../worker/redirects/service";
import { SettingsService } from "../worker/settings/service";
import { fixtureSessionToken, seedContentAccess } from "./content-fixture";

const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
const subjectId = "7adc66ac-6b84-4c7b-b12e-3d38ac086048";
const anotherId = "85c87a45-ab0d-48f0-8ee5-03dcd5d8afad";
const timestamp = "2026-09-23T12:00:00.000Z";
const canary = "private-file-value-not-for-audit";
let access: ContentWriteAccess;
let service: AuditService;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
  access = await seedContentAccess(env.DB);
  service = new AuditService(env.DB, access);
});

async function fileEvent(
  action: FileAction = "file.rename",
  changedFields: readonly FileField[] = ["name"],
  options: { id?: string; version?: number; time?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,source_page_event_id,details_json,created_at)
     VALUES('file',?,?,?,NULL,'current',NULL,?,?)`,
  )
    .bind(
      options.id ?? subjectId,
      options.version ?? 1,
      action,
      JSON.stringify({ changedFields }),
      options.time ?? timestamp,
    )
    .run();
}

// Simulate corrupted storage responses without changing the immutable database
// records or weakening their insert validator. All authentication reads stay real.
function malformedRead(overrides: Record<string, unknown>) {
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM audit_records a")) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async all() {
                  const result = await bound.all<Record<string, unknown>>();
                  return {
                    ...result,
                    results: result.results.map((row) =>
                      row.category === "file" ? { ...row, ...overrides } : row,
                    ),
                  };
                },
              };
            },
          } as D1PreparedStatement;
        };
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function auditRequest(query = "", db = env.DB, authenticated = true) {
  return adminApi(
    new Request(
      `https://example.com/api/admin/audit${query ? `?${query}` : ""}`,
      {
        headers: authenticated
          ? { Cookie: `__Host-wiki_session=${fixtureSessionToken}` }
          : {},
      },
    ),
    { ...env, DB: db },
  );
}

describe("file audit metadata and reads", () => {
  it("decodes every agreed file action with only closed changed-field metadata", async () => {
    expect(
      AUDIT_ACTIONS.filter((action) => action.startsWith("file.")),
    ).toEqual(FILE_ACTIONS);
    for (const [index, action] of FILE_ACTIONS.entries())
      await fileEvent(action, FILE_FIELDS, { version: index + 1 });
    const result = await service.list({ category: "file", language: "site" });
    expect(result.items).toHaveLength(FILE_ACTIONS.length);
    expect(result.items.map((item) => item.action)).toEqual(
      [...FILE_ACTIONS].reverse(),
    );
    expect(result.nextCursor).toBeNull();
    for (const [index, item] of result.items.entries()) {
      expect(item).toEqual({
        seq: expect.any(Number),
        category: "file",
        action: FILE_ACTIONS[FILE_ACTIONS.length - index - 1],
        subjectId,
        subjectVersion: FILE_ACTIONS.length - index,
        language: null,
        origin: "current",
        createdAt: timestamp,
        details: { changedFields: [...FILE_FIELDS] },
        pageTitle: null,
      });
    }
  });

  it("accepts authenticated file filters and keeps the endpoint private and read-only", async () => {
    await fileEvent();
    await fileEvent("file.alt", ["alt.zh", "alt.en"], { version: 2 });
    await fileEvent("file.rename", ["name"], { id: anotherId });
    const query = new URLSearchParams({
      category: "file",
      action: "file.rename",
      language: "site",
      subjectId,
      from: timestamp,
      to: "2026-09-23T12:00:00.001Z",
    }).toString();
    const response = await auditRequest(query);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Robots-Tag")).toContain("noindex");
    const result = (await response?.json()) as AuditPage;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      category: "file",
      action: "file.rename",
      subjectId,
      details: { changedFields: ["name"] },
    });
    expect((await auditRequest(query, env.DB, false))?.status).toBe(401);
    expect(
      (await service.list({ category: "file", language: "zh" })).items,
    ).toEqual([]);
    expect(
      (await service.list({ category: "file", language: "en" })).items,
    ).toEqual([]);
    expect(
      (await service.list({ category: "file", to: timestamp })).items,
    ).toEqual([]);
    for (const invalid of [
      "category=file&action=page.delete",
      "category=page&action=file.delete",
      "category=file&action=file.unknown",
      "category=file&category=file",
      "action=file.rename&action=file.move",
      "category=file&receiptToken=secret-canary",
    ])
      expect((await auditRequest(invalid))?.status).toBe(400);
  });

  it("binds file pagination to filters and excludes events added between pages", async () => {
    for (let version = 1; version <= 3; version++)
      await fileEvent("file.rename", ["name"], { version });
    const options = {
      category: "file",
      action: "file.rename",
      subjectId,
      language: "site",
      limit: 1,
    } as const;
    const first = await service.list(options);
    expect(first.items[0]?.subjectVersion).toBe(3);
    expect(first.nextCursor).not.toBeNull();
    await fileEvent("file.rename", ["name"], { version: 4 });
    const second = await service.list({
      ...options,
      cursor: first.nextCursor ?? "",
      limit: 50,
    });
    expect(second.items.map((item) => item.subjectVersion)).toEqual([2, 1]);
    expect(second.nextCursor).toBeNull();
    for (const changed of [
      { action: "file.move" },
      { subjectId: anotherId },
      { language: "en" },
    ] as const)
      await expect(
        service.list({
          ...options,
          ...changed,
          cursor: first.nextCursor ?? "",
        }),
      ).rejects.toMatchObject({ status: 400 });
  });

  it("preserves existing mixed records when file events join the audit trail", async () => {
    const content = new ContentService(env.DB, access);
    const page = await content.createTranslation({
      language: "en",
      path: "files-audit-page",
      title: "Existing page",
      description: "",
      markdown: canary,
      tags: [],
    });
    await new NavigationService(env.DB, access).save("en", {
      expectedVersion: 1,
      mode: "custom",
      nodes: [],
    });
    const redirects = new RedirectService(env.DB, access);
    await redirects.create("en", {
      expectedVersion: (await redirects.list("en")).version,
      path: "files-audit-alias",
      translationId: page.id,
    });
    await new SettingsService(env.DB, access).update({
      ...structuredClone(INITIAL_SITE_SETTINGS),
      expectedVersion: 1,
      accent: "plum",
    });
    const before = await service.list({ limit: 50 });
    expect(new Set(before.items.map((item) => item.category))).toEqual(
      new Set(["page", "navigation", "redirect", "settings", "administrator"]),
    );
    expect(before.items.some((item) => item.origin === "legacy")).toBe(true);
    await fileEvent("file.alt", ["alt.zh", "alt.en"]);
    const after = await service.list({ limit: 50 });
    expect(after.items.filter((item) => item.category !== "file")).toEqual(
      before.items,
    );
    expect(JSON.stringify(after)).not.toContain(canary);
  });

  it("checks the live session for populated and empty file filters", async () => {
    await fileEvent();
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?")
      .bind(access.tokenHash)
      .run();
    await expect(service.list({ category: "file" })).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      service.list({ category: "file", subjectId: anotherId }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("file audit decoder fails closed", () => {
  it("rejects malformed details, unknown fields, duplicate fields and embedded private values", async () => {
    await fileEvent();
    const details = [
      null,
      [],
      {},
      { changedFields: [] },
      { changedFields: "name" },
      { changedFields: ["name", "name"] },
      { changedFields: [...FILE_FIELDS, "name"] },
      { changedFields: [null] },
      { changedFields: [1] },
      { changedFields: [{ name: canary }] },
      { changedFields: ["filename"] },
      { changedFields: ["receiptToken"] },
      ...[
        "filename",
        "name",
        "alt",
        "objectKey",
        "sha256",
        "receiptToken",
        "values",
      ].map((key) => ({ changedFields: ["name"], [key]: canary })),
    ];
    for (const details_json of [
      "not-json",
      ...details.map((value) => JSON.stringify(value)),
    ]) {
      const corrupted = new AuditService(
        malformedRead({ details_json }),
        access,
      );
      await expect(corrupted.list({ category: "file" })).rejects.toEqual(
        new AuditError(503, "Audit storage is temporarily unavailable."),
      );
    }
  });

  it("rejects non-file actions and invalid event identity or provenance", async () => {
    await fileEvent();
    for (const overrides of [
      { action: "file.inject" },
      { action: "settings.update" },
      { language: "zh" },
      { language: "en" },
      { language: undefined },
      { origin: "legacy" },
      { source_page_event_id: "page-event-canary" },
      { source_page_event_id: undefined },
      { page_title: canary },
      { subject_id: "not-a-uuid" },
      { subject_id: subjectId.toUpperCase() },
      { subject_id: "00000000-0000-0000-0000-000000000000" },
      { subject_version: 0 },
      { subject_version: 1.5 },
      { subject_version: Number.MAX_SAFE_INTEGER + 1 },
      { subject_version: "1" },
      { seq: 0 },
      { seq: Number.MAX_SAFE_INTEGER + 1 },
    ])
      await expect(
        new AuditService(malformedRead(overrides), access).list({
          category: "file",
        }),
      ).rejects.toEqual(
        new AuditError(503, "Audit storage is temporarily unavailable."),
      );
  });

  it("returns one generic HTTP failure instead of leaking malformed file details or partial mixed results", async () => {
    await fileEvent();
    const response = await auditRequest(
      "",
      malformedRead({
        details_json: JSON.stringify({
          changedFields: ["name"],
          receiptToken: canary,
        }),
      }),
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.json()).toEqual({
      error: "Audit storage is temporarily unavailable.",
    });
  });
});
