import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "../shared/auth";
import {
  INITIAL_SITE_SETTINGS,
  SETTINGS_FIELDS,
  type SiteSettingsInput,
} from "../shared/settings";
import type { ContentWriteAccess } from "../worker/auth/access";
import { ContentService } from "../worker/content/service";
import { NavigationService } from "../worker/navigation/service";
import { RedirectService } from "../worker/redirects/service";
import { getSiteSettings, SettingsService } from "../worker/settings/service";
import { seedContentAccess } from "./content-fixture";

const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
let access: ContentWriteAccess;
let service: SettingsService;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
  access = await seedContentAccess(env.DB);
  service = new SettingsService(env.DB, access);
});
function input(overrides: Partial<SiteSettingsInput> = {}): SiteSettingsInput {
  return {
    ...structuredClone(INITIAL_SITE_SETTINGS),
    expectedVersion: 1,
    ...overrides,
  };
}
async function snapshot() {
  return (
    await env.DB.batch([
      env.DB.prepare("SELECT * FROM site_settings"),
      env.DB.prepare("SELECT * FROM audit_records ORDER BY seq"),
    ])
  ).map((result) => result.results);
}
async function audit() {
  return (
    await env.DB.prepare(
      "SELECT * FROM audit_records WHERE category='settings' ORDER BY seq",
    ).all<{
      subject_id: string;
      subject_version: number;
      action: string;
      language: null;
      origin: string;
      details_json: string;
    }>()
  ).results;
}
function beforeBatch(action: () => Promise<unknown>) {
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

describe("site settings seed and database invariants", () => {
  it("seeds the agreed public values once without inventing a settings audit event", async () => {
    const current = await service.get();
    expect(current).toMatchObject({ ...INITIAL_SITE_SETTINGS, version: 1 });
    expect(new Date(current.updatedAt).toISOString()).toBe(current.updatedAt);
    expect(await getSiteSettings(env.DB)).toEqual(current);
    expect(await audit()).toEqual([]);
    await service.update(input({ theme: "dark" }));
    const before = await snapshot();
    await applyD1Migrations(env.DB, migrations);
    expect(await snapshot()).toEqual(before);
  });

  it("preserves existing rows and all earlier audit categories when migrating", async () => {
    await reset();
    const index = migrations.findIndex(
      (item) => item.name === "0009_site_settings.sql",
    );
    expect(index).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, migrations.slice(0, index));
    access = await seedContentAccess(env.DB);
    const content = new ContentService(env.DB, access);
    const page = await content.createTranslation({
      language: "en",
      path: "settings-migration-page",
      title: "Existing page",
      description: "",
      markdown: "Body",
      tags: [],
    });
    const redirects = new RedirectService(env.DB, access);
    await redirects.create("en", {
      expectedVersion: (await redirects.list("en")).version,
      path: "settings-migration-alias",
      translationId: page.id,
    });
    await new NavigationService(env.DB, access).save("en", {
      expectedVersion: 1,
      mode: "custom",
      nodes: [],
    });
    const oldAudit = (
      await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all()
    ).results;
    const oldPages = (
      await env.DB.prepare("SELECT * FROM page_translations ORDER BY id").all()
    ).results;
    await applyD1Migrations(env.DB, migrations);
    expect(
      (await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all())
        .results,
    ).toEqual(oldAudit);
    expect(
      (
        await env.DB.prepare(
          "SELECT * FROM page_translations ORDER BY id",
        ).all()
      ).results,
    ).toEqual(oldPages);
    await content.move(page.id, page.version, "settings-migration-moved");
    await redirects.delete("en", {
      expectedVersion: (await redirects.list("en")).version,
      sourcePath: "settings-migration-alias",
    });
    await new NavigationService(env.DB, access).save("en", {
      expectedVersion: 2,
      mode: "automatic",
      nodes: [],
    });
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE administrators SET username='updated-fixture-owner',auth_version=auth_version+1,updated_at=? WHERE id=1",
    )
      .bind(now)
      .run();
    const actions = (
      await env.DB.prepare("SELECT DISTINCT action FROM audit_records").all<{
        action: string;
      }>()
    ).results.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "page.move",
        "redirect.delete",
        "navigation.save",
        "administrator.credentials",
      ]),
    );
    expect(await getSiteSettings(env.DB)).toMatchObject(INITIAL_SITE_SETTINGS);
  });

  it("blocks deletion, replacement, identity changes and version changes without a real edit", async () => {
    const before = await snapshot();
    for (const sql of [
      "DELETE FROM site_settings",
      "INSERT OR REPLACE INTO site_settings SELECT * FROM site_settings",
      "UPDATE site_settings SET id=2",
      "UPDATE site_settings SET version=version+1",
      "UPDATE site_settings SET updated_at='2026-09-23T12:00:00.000Z'",
      "UPDATE site_settings SET theme='dark'",
      "UPDATE site_settings SET theme='dark',version=version+2",
    ])
      await expect(env.DB.prepare(sql).run()).rejects.toThrow(/settings_/);
    expect(await snapshot()).toEqual(before);
    await env.DB.prepare("UPDATE site_settings SET theme=theme").run();
    expect(await snapshot()).toEqual(before);
  });

  it("records exactly the changed field names without settings values", async () => {
    const changed = input({
      locales: {
        zh: { name: "私有审计值哨兵", description: "新的说明" },
        en: { name: "Audit value canary", description: "New description" },
      },
      defaultLanguage: "en",
      theme: "dark",
      accent: "ocean",
      logo: "book",
    });
    const result = await service.update(changed);
    expect(result.version).toBe(2);
    expect(result.locales).toEqual(changed.locales);
    const events = await audit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      subject_id: "1",
      subject_version: 2,
      action: "settings.update",
      language: null,
      origin: "current",
    });
    expect(JSON.parse(events[0]?.details_json ?? "{}")).toEqual({
      changedFields: SETTINGS_FIELDS,
    });
    expect(JSON.stringify(events)).not.toContain("Audit value canary");
    expect(JSON.stringify(events)).not.toContain("私有审计值哨兵");
    const next = await service.update({
      ...changed,
      expectedVersion: 2,
      logo: "none",
    });
    expect(next.version).toBe(3);
    expect(JSON.parse((await audit())[1]?.details_json ?? "{}")).toEqual({
      changedFields: ["logo"],
    });
  });

  it("enforces the closed, unique settings audit schema in SQL", async () => {
    const before = await audit();
    for (const details of [
      null,
      {},
      { changedFields: [] },
      { changedFields: "theme" },
      { changedFields: ["theme", "theme"] },
      { changedFields: ["secret"] },
      { changedFields: [null] },
      { changedFields: [0] },
      { changedFields: [true] },
      { changedFields: [{ field: "theme" }] },
      { changedFields: ["theme"], values: { theme: "dark" } },
      { changedFields: [...SETTINGS_FIELDS, "theme"] },
    ])
      await expect(
        env.DB.prepare(
          "INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at) VALUES('settings','1',2,'settings.update',NULL,'current',?,?)",
        )
          .bind(JSON.stringify(details), new Date().toISOString())
          .run(),
      ).rejects.toThrow("audit_invalid");
    for (const [action, language, subject, origin] of [
      ["settings.delete", null, "1", "current"],
      ["settings.update", "en", "1", "current"],
      ["settings.update", null, "2", "current"],
      ["settings.update", null, "1", "legacy"],
    ] as const)
      await expect(
        env.DB.prepare(
          "INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at) VALUES('settings',?,2,?,?,?,'{\"changedFields\":[\"theme\"]}',?)",
        )
          .bind(subject, action, language, origin, new Date().toISOString())
          .run(),
      ).rejects.toThrow("audit_invalid");
    expect(await audit()).toEqual(before);
  });
});

describe("settings input and persisted data validation", () => {
  it("normalizes trimmed text and accepts bounded bilingual fields and every preset", async () => {
    const result = await service.update(
      input({
        locales: {
          zh: {
            name: `  ${"文".repeat(80)}  `,
            description: ` ${"字".repeat(300)} `,
          },
          en: { name: "  A name  ", description: "   " },
        },
      }),
    );
    expect(result.locales.zh.name).toHaveLength(80);
    expect(result.locales.zh.description).toHaveLength(300);
    expect(result.locales.en).toEqual({ name: "A name", description: "" });
    const { version, updatedAt: _updatedAt, ...values } = result;
    const light = await service.update({
      ...values,
      expectedVersion: version,
      theme: "light",
      accent: "plum",
      logo: "none",
    });
    expect(light).toMatchObject({
      theme: "light",
      accent: "plum",
      logo: "none",
    });
  });

  it("rejects unknown or missing nested fields, invalid presets, controls and oversized text without writes", async () => {
    const before = await snapshot();
    const badInputs: unknown[] = [
      null,
      [],
      { ...input(), extra: true },
      { ...input(), expectedVersion: 0 },
      { ...input(), expectedVersion: 1.5 },
      { ...input(), expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...input(), expectedVersion: "1" },
      { ...input(), theme: "auto" },
      { ...input(), accent: "#fff" },
      { ...input(), logo: "https://example.com/logo.svg" },
      { ...input(), defaultLanguage: "fr" },
      { ...input(), locales: { zh: INITIAL_SITE_SETTINGS.locales.zh } },
      {
        ...input(),
        locales: {
          ...INITIAL_SITE_SETTINGS.locales,
          fr: INITIAL_SITE_SETTINGS.locales.en,
        },
      },
      {
        ...input(),
        locales: { ...INITIAL_SITE_SETTINGS.locales, zh: { name: "Name" } },
      },
      {
        ...input(),
        locales: {
          ...INITIAL_SITE_SETTINGS.locales,
          zh: { name: "Name", description: "", html: "x" },
        },
      },
    ];
    for (const name of [
      "",
      "   ",
      "x".repeat(81),
      "😀".repeat(41),
      "x\u0000y",
      "x\ny",
      "x\u007fy",
      "x\u0085y",
    ])
      badInputs.push(
        input({
          locales: {
            ...INITIAL_SITE_SETTINGS.locales,
            en: { name, description: "" },
          },
        }),
      );
    for (const description of ["x".repeat(301), "x\ty", "\ry"])
      badInputs.push(
        input({
          locales: {
            ...INITIAL_SITE_SETTINGS.locales,
            en: { name: "Name", description },
          },
        }),
      );
    for (const candidate of badInputs)
      await expect(
        service.update(candidate as SiteSettingsInput),
      ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it("fails closed for missing storage without recreating its initial values", async () => {
    await env.DB.exec(
      "DROP TRIGGER site_settings_no_delete; DELETE FROM site_settings;",
    );
    await expect(getSiteSettings(env.DB)).rejects.toMatchObject({
      status: 503,
    });
    await expect(service.get()).rejects.toMatchObject({ status: 503 });
    await expect(
      service.update(input({ theme: "dark" })),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await env.DB.prepare("SELECT count(*) AS count FROM site_settings").first(
        "count",
      ),
    ).toBe(0);
  });

  it.each([" padded ", "control\u0085value"])(
    "rejects noncanonical stored text in public and private reads and writes: %s",
    async (value) => {
      await env.DB.prepare(
        "UPDATE site_settings SET en_name=?,version=version+1",
      )
        .bind(value)
        .run();
      const before = await snapshot();
      await expect(getSiteSettings(env.DB)).rejects.toMatchObject({
        status: 503,
      });
      await expect(service.get()).rejects.toMatchObject({ status: 503 });
      await expect(
        service.update(input({ expectedVersion: 2, theme: "dark" })),
      ).rejects.toMatchObject({ status: 503 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("maps preparation and query failures to generic storage errors", async () => {
    const failed = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return () => {
            throw new Error("private-sql-credential-canary");
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const privateFailed = new SettingsService(failed, access);
    for (const request of [
      getSiteSettings(failed),
      privateFailed.get(),
      privateFailed.update(input({ theme: "dark" })),
    ])
      await expect(request).rejects.toMatchObject({
        status: 503,
        message: "Site settings are temporarily unavailable.",
      });
    await env.DB.exec("DROP TABLE site_settings;");
    await expect(getSiteSettings(env.DB)).rejects.toMatchObject({
      status: 503,
      message: "Site settings are temporarily unavailable.",
    });
    await expect(service.get()).rejects.toMatchObject({
      status: 503,
      message: "Site settings are temporarily unavailable.",
    });
  });
});

describe("settings session and version transactions", () => {
  it("does not advance the version, timestamp or audit for an unchanged normalized request", async () => {
    const current = await service.get();
    const before = await snapshot();
    expect(await service.update(input())).toEqual(current);
    expect(
      await service.update(
        input({
          locales: {
            ...INITIAL_SITE_SETTINGS.locales,
            en: {
              name: "  Emby Wiki  ",
              description: " Emby Wiki documentation ",
            },
          },
        }),
      ),
    ).toEqual(current);
    expect(await snapshot()).toEqual(before);
  });

  it("allows one concurrent writer and rejects stale writes including stale no-ops", async () => {
    const outcomes = await Promise.allSettled([
      service.update(input({ theme: "dark" })),
      service.update(input({ accent: "ocean" })),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 412 } });
    const current = await service.get();
    const { version: _version, updatedAt: _updatedAt, ...values } = current;
    const before = await snapshot();
    await expect(
      service.update({ ...values, expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 412 });
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toHaveLength(1);
  });

  it("returns the saved version from the write batch even if another writer follows immediately", async () => {
    let injected = false;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!injected) {
              injected = true;
              await service.update(
                input({ expectedVersion: 2, theme: "light" }),
              );
            }
            return result;
          };
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    expect(
      await new SettingsService(db, access).update(input({ theme: "dark" })),
    ).toMatchObject({ version: 2, theme: "dark" });
    expect(await service.get()).toMatchObject({ version: 3, theme: "light" });
  });

  it.each(["logout", "credentials", "absolute", "idle"] as const)(
    "rejects private reads and writes after %s while public settings remain readable",
    async (kind) => {
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
      const before = await snapshot();
      await expect(service.get()).rejects.toMatchObject({ status: 401 });
      await expect(
        service.update(input({ theme: "dark" })),
      ).rejects.toMatchObject({ status: 401 });
      expect(await getSiteSettings(env.DB)).toMatchObject(
        INITIAL_SITE_SETTINGS,
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([false, true])(
    "rechecks a revoked session inside a write batch even for no-op=%s",
    async (noop) => {
      const before = await snapshot();
      const db = beforeBatch(() =>
        env.DB.prepare("DELETE FROM admin_sessions").run(),
      );
      await expect(
        new SettingsService(db, access).update(
          input({ theme: noop ? "system" : "dark" }),
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("rejects malformed access before reading settings", () => {
    for (const invalid of [
      { tokenHash: "invalid", authVersion: 1 },
      { tokenHash: access.tokenHash, authVersion: 0 },
    ])
      expect(() => new SettingsService(env.DB, invalid)).toThrow(
        "Authentication required.",
      );
  });

  it("rolls back the settings version and values when audit insertion fails", async () => {
    const before = await snapshot();
    await env.DB.exec(
      "CREATE TRIGGER settings_fixture_failure BEFORE INSERT ON audit_records WHEN NEW.category='settings' BEGIN SELECT RAISE(ABORT,'private_audit_failure'); END;",
    );
    await expect(
      service.update(input({ theme: "dark" })),
    ).rejects.toMatchObject({
      status: 503,
      message: "Site settings are temporarily unavailable.",
    });
    expect(await snapshot()).toEqual(before);
  });
});
