import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditPage } from "../shared/audit";
import {
  INITIAL_SITE_SETTINGS,
  type SiteSettings,
  type SiteSettingsInput,
} from "../shared/settings";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";
import { fixtureSessionToken, seedContentAccess } from "./content-fixture";

const origin = "https://example.com";
const cookie = `__Host-wiki_session=${fixtureSessionToken}`;
let headers: Record<string, string>;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  await seedContentAccess(env.DB);
  headers = {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": await sha256(`csrf:${fixtureSessionToken}`),
  };
});
function input(expectedVersion = 1): SiteSettingsInput {
  return { ...structuredClone(INITIAL_SITE_SETTINGS), expectedVersion };
}
function request(
  method = "GET",
  body?: unknown,
  suffix = "",
  requestHeaders = headers,
) {
  return exports.default.fetch(`${origin}/api/admin/settings${suffix}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function current() {
  const response = await request();
  expect(response.status).toBe(200);
  return (await response.json()) as SiteSettings;
}
async function events() {
  const response = await exports.default.fetch(
    `${origin}/api/admin/audit?category=settings&language=site`,
    { headers },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as AuditPage).items;
}

describe("administrator site settings HTTP boundary", () => {
  it("authenticates before methods, unknown paths and query validation", async () => {
    for (const suffix of ["", "?unexpected=1", "/private"])
      for (const method of ["GET", "PUT", "POST", "DELETE"])
        for (const Cookie of [
          "",
          `${cookie}; ${cookie}`,
          "__Host-wiki_session=invalid",
        ]) {
          const response = await request(method, undefined, suffix, { Cookie });
          expect(response.status).toBe(401);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
          expect(
            response.headers.get("Access-Control-Allow-Origin"),
          ).toBeNull();
        }
  });

  it("returns the complete seeded settings with private response headers", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...INITIAL_SITE_SETTINGS,
      version: 1,
      updatedAt: expect.any(String),
    });
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Content-Security-Policy")).not.toMatch(
      /unsafe-inline|unsafe-eval/,
    );
    expect(await events()).toEqual([]);
  });

  it("allows only exact GET and PUT without query parameters", async () => {
    for (const method of ["POST", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      const response = await request(method);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, PUT");
    }
    for (const suffix of ["?version=1", "?theme=dark&theme=light", "?unknown="])
      expect((await request("GET", undefined, suffix)).status).toBe(400);
    expect((await request("GET", undefined, "/")).status).toBe(404);
    expect((await request("PUT", input(), "?unknown=1")).status).toBe(400);
  });

  it("requires both exact Origin and session-bound CSRF without changing settings", async () => {
    const before = await current();
    const changed = { ...input(), theme: "dark" };
    for (const Origin of [
      "",
      "null",
      "https://outside.example",
      `${origin}/path`,
    ])
      expect(
        (await request("PUT", changed, "", { ...headers, Origin })).status,
      ).toBe(403);
    for (const token of ["", "invalid"])
      expect(
        (
          await request("PUT", changed, "", {
            ...headers,
            "X-CSRF-Token": token,
          })
        ).status,
      ).toBe(403);
    expect(await current()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it("saves bilingual values and audits only the names of changed fields", async () => {
    const changed = input();
    changed.locales.zh.name = "测试知识库";
    changed.locales.en.description = "A dedicated documentation space";
    changed.defaultLanguage = "en";
    changed.theme = "dark";
    changed.accent = "ocean";
    changed.logo = "book";
    const response = await request("PUT", changed);
    expect(response.status).toBe(200);
    const saved = (await response.json()) as SiteSettings;
    expect(saved).toMatchObject({
      version: 2,
      locales: changed.locales,
      defaultLanguage: "en",
      theme: "dark",
      accent: "ocean",
      logo: "book",
    });
    const records = await events();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: "settings",
      action: "settings.update",
      subjectId: "1",
      subjectVersion: 2,
      language: null,
      details: {
        changedFields: [
          "zh.name",
          "en.description",
          "defaultLanguage",
          "theme",
          "accent",
          "logo",
        ],
      },
    });
    expect(JSON.stringify(records)).not.toContain(changed.locales.zh.name);
    expect(JSON.stringify(records)).not.toContain(
      changed.locales.en.description,
    );
    expect(await current()).toEqual(saved);
  });

  it("does not increment or audit unchanged saves, including normalized whitespace", async () => {
    const before = await current();
    const unchanged = input();
    unchanged.locales.zh.name = `  ${unchanged.locales.zh.name}  `;
    expect((await request("PUT", unchanged)).status).toBe(200);
    expect(await current()).toEqual(before);
    expect(await events()).toEqual([]);
  });

  it("rejects stale writes without hiding the latest values or adding an event", async () => {
    const accepted = await request("PUT", { ...input(), theme: "light" });
    expect(accepted.status).toBe(200);
    expect((await request("PUT", { ...input(), accent: "plum" })).status).toBe(
      412,
    );
    expect((await current()).theme).toBe("light");
    expect((await current()).accent).toBe("forest");
    expect(await events()).toHaveLength(1);
  });

  it("rejects malformed versions, unknown fields and unsafe nested values", async () => {
    const invalid: unknown[] = [
      { ...input(), expectedVersion: { toString: null, valueOf: null } },
      { ...input(), expectedVersion: "1" },
      { ...input(), expectedVersion: 0 },
      { ...input(), expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...input(), extra: true },
      { ...input(), theme: "javascript:alert(1)" },
      { ...input(), logo: "https://outside.example/logo.svg" },
      { ...input(), locales: { ...input().locales, fr: input().locales.en } },
      { ...input(), locales: { zh: null, en: input().locales.en } },
      {
        ...input(),
        locales: { zh: { name: " ", description: "" }, en: input().locales.en },
      },
      {
        ...input(),
        locales: {
          zh: { name: "x".repeat(81), description: "" },
          en: input().locales.en,
        },
      },
      {
        ...input(),
        locales: {
          zh: { name: "name", description: "x".repeat(301) },
          en: input().locales.en,
        },
      },
      {
        ...input(),
        locales: {
          zh: { name: "bad\u0085name", description: "" },
          en: input().locales.en,
        },
      },
    ];
    for (const value of invalid)
      expect((await request("PUT", value)).status).toBe(400);
    expect((await current()).version).toBe(1);
    expect(await events()).toEqual([]);
  });

  it("bounds streamed UTF-8 JSON and rejects malformed JSON before mutation", async () => {
    for (const body of ["{broken", "[]", "null"])
      expect(
        (
          await adminApi(
            new Request(`${origin}/api/admin/settings`, {
              method: "PUT",
              headers,
              body,
            }),
            env,
          )
        ).status,
      ).toBe(400);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ ...input(), padding: "界".repeat(1500) }),
          ),
        );
        controller.close();
      },
    });
    const response = await adminApi(
      new Request(`${origin}/api/admin/settings`, {
        method: "PUT",
        headers,
        body,
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The request is too large.",
    });
    expect((await current()).version).toBe(1);
  });

  it("rechecks a session revoked while the authenticated body is being read", async () => {
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          read = true;
          await env.DB.prepare("DELETE FROM admin_sessions").run();
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ ...input(), theme: "dark" }),
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await adminApi(
      new Request(`${origin}/api/admin/settings`, {
        method: "PUT",
        headers,
        body,
      }),
      env,
    );
    expect(read).toBe(true);
    expect(response.status).toBe(401);
    await seedContentAccess(env.DB);
    expect((await current()).version).toBe(1);
    expect(await events()).toEqual([]);
  });
});
