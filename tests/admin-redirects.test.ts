import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditPage } from "../shared/audit";
import type {
  RedirectDocument,
  RedirectMutationResult,
} from "../shared/redirects";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";
import { ContentService } from "../worker/content/service";
import { fixtureSessionToken, seedContentAccess } from "./content-fixture";

const origin = "https://example.com";
const cookie = `__Host-wiki_session=${fixtureSessionToken}`;
let headers: Record<string, string>;
let content: ContentService;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const access = await seedContentAccess(env.DB);
  content = new ContentService(env.DB, access);
  headers = {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": await sha256(`csrf:${fixtureSessionToken}`),
  };
});

function request(
  path = "/en",
  method = "GET",
  input?: unknown,
  requestHeaders = headers,
) {
  return exports.default.fetch(`${origin}/api/admin/redirects${path}`, {
    method,
    headers: requestHeaders,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function list(path = "/en") {
  const response = await request(path);
  expect(response.status).toBe(200);
  return (await response.json()) as RedirectDocument;
}
function createInput(expectedVersion: number, path = "old-home") {
  return { expectedVersion, path, translationId: "starter-home-en" };
}
async function create(path = "old-home") {
  const initial = await list();
  const response = await request(
    "/en",
    "POST",
    createInput(initial.version, path),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as RedirectMutationResult;
}
async function snapshot() {
  const [routes, audits] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM page_routes ORDER BY language,path"),
    env.DB.prepare("SELECT * FROM audit_records ORDER BY seq"),
  ]);
  return {
    document: await list(),
    routes: routes?.results,
    audits: audits?.results,
  };
}

describe("administrator redirect HTTP boundary", () => {
  it("authenticates every method before path, query or payload validation", async () => {
    for (const path of ["/en", "/zh", "/fr?unexpected=1"])
      for (const method of ["GET", "POST", "PUT", "DELETE"])
        for (const Cookie of [
          "",
          `${cookie}; ${cookie}`,
          "__Host-wiki_session=invalid",
        ]) {
          const response = await request(path, method, undefined, { Cookie });
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: "Sign in required" });
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
          expect(
            response.headers.get("Access-Control-Allow-Origin"),
          ).toBeNull();
        }
    await env.DB.prepare("DELETE FROM admin_sessions").run();
    expect((await request()).status).toBe(401);
    expect((await request("/en", "POST", createInput(1))).status).toBe(401);
  });

  it("returns independent empty alias registries, never canonical routes", async () => {
    for (const language of ["zh", "en"]) {
      const response = await request(`/${language}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        language,
        items: [],
        nextCursor: null,
      });
      expect(response.headers.get("Content-Security-Policy")).not.toMatch(
        /unsafe-inline|unsafe-eval/,
      );
      expect(response.headers.get("Vary")).toContain("Cookie");
    }
  });

  it("creates, renames, retargets and deletes an alias with explicit versions", async () => {
    const initial = await list();
    const created = await create();
    expect(created).toMatchObject({
      language: "en",
      version: initial.version + 1,
      item: {
        path: "old-home",
        translationId: "starter-home-en",
        targetPath: "home",
        origin: "manual",
        targetStatus: "published",
      },
    });
    const update = await request("/en", "PUT", {
      expectedVersion: created.version,
      sourcePath: "old-home",
      path: "older-home",
      translationId: "starter-reading-en",
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as RedirectMutationResult;
    expect(updated).toMatchObject({
      version: created.version + 1,
      item: { path: "older-home", translationId: "starter-reading-en" },
    });
    expect((await list("/en?sourcePath=old-home")).items).toEqual([]);
    expect((await list("/en?sourcePath=older-home")).items).toHaveLength(1);
    const removed = await request("/en", "DELETE", {
      expectedVersion: updated.version,
      sourcePath: "older-home",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      language: "en",
      version: updated.version + 1,
    });
    expect((await list()).items).toEqual([]);
  });

  it("allows editing and deleting automatic aliases while canonical paths stay protected", async () => {
    const page = await content.createTranslation({
      language: "en",
      path: "automatic-old",
      title: "Private draft title",
      description: "",
      markdown: "PRIVATE ALIAS BODY",
      tags: [],
      changeNote: "PRIVATE ALIAS NOTE",
    });
    const moved = await content.move(page.id, page.version, "automatic-new");
    const initial = await list("/en?origin=automatic");
    expect(initial.items).toMatchObject([
      {
        path: "automatic-old",
        origin: "automatic",
        translationId: page.id,
        targetStatus: "draft",
      },
    ]);
    const edited = await request("/en", "PUT", {
      expectedVersion: initial.version,
      sourcePath: "automatic-old",
      path: "edited-old",
      translationId: moved.id,
    });
    expect(edited.status).toBe(200);
    const saved = (await edited.json()) as RedirectMutationResult;
    const before = await snapshot();
    for (const input of [
      {
        expectedVersion: saved.version,
        sourcePath: "automatic-new",
        path: "attempted",
        translationId: moved.id,
      },
      {
        expectedVersion: saved.version,
        sourcePath: "edited-old",
        path: "automatic-new",
        translationId: moved.id,
      },
    ])
      expect((await request("/en", "PUT", input)).status).toBe(409);
    expect(
      (
        await request("/en", "DELETE", {
          expectedVersion: saved.version,
          sourcePath: "automatic-new",
        })
      ).status,
    ).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await request("/en", "DELETE", {
          expectedVersion: saved.version,
          sourcePath: "edited-old",
        })
      ).status,
    ).toBe(200);
  });

  it("returns 412 for stale writes and lets an exact-path read show the current winner", async () => {
    const created = await create();
    const update = await request("/en", "PUT", {
      expectedVersion: created.version,
      sourcePath: created.item.path,
      path: "winner-path",
      translationId: created.item.translationId,
    });
    expect(update.status).toBe(200);
    const winner = (await update.json()) as RedirectMutationResult;
    const before = await snapshot();
    for (const [method, input] of [
      ["POST", createInput(created.version, "lost")],
      [
        "PUT",
        {
          expectedVersion: created.version,
          sourcePath: "winner-path",
          path: "lost",
          translationId: created.item.translationId,
        },
      ],
      [
        "DELETE",
        { expectedVersion: created.version, sourcePath: "winner-path" },
      ],
    ] as const)
      expect((await request("/en", method, input)).status).toBe(412);
    expect(await snapshot()).toEqual(before);
    expect(await list("/en?sourcePath=winner-path")).toMatchObject({
      version: winner.version,
      items: [winner.item],
    });
  });

  it("requires exact Origin and CSRF for every mutation without route or audit side effects", async () => {
    const created = await create();
    const before = await snapshot();
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: "" },
      { Origin: "https://attacker.invalid" },
      { Origin: `${origin}/` },
      { "Sec-Fetch-Site": "cross-site" },
      { "X-CSRF-Token": "" },
      { "X-CSRF-Token": "wrong" },
    ];
    for (const overrides of rejectedHeaders)
      for (const [method, input] of [
        ["POST", createInput(created.version, "blocked")],
        [
          "PUT",
          {
            ...createInput(created.version, "blocked"),
            sourcePath: created.item.path,
          },
        ],
        [
          "DELETE",
          { expectedVersion: created.version, sourcePath: created.item.path },
        ],
      ] as const)
        expect(
          (await request("/en", method, input, { ...headers, ...overrides }))
            .status,
        ).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect(
      (await request("/en", "GET", undefined, { Cookie: cookie })).status,
    ).toBe(200);
  });

  it("rejects coercions, extra keys, missing fields and invalid mutation versions", async () => {
    const initial = await list();
    const valid = createInput(initial.version);
    for (const input of [
      { ...valid, extra: true },
      { ...valid, expectedVersion: "1" },
      { ...valid, expectedVersion: { valueOf: null, toString: null } },
      { ...valid, expectedVersion: 0 },
      { ...valid, expectedVersion: 1.5 },
      { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, path: null },
      { ...valid, translationId: [] },
      { path: "old-home", translationId: "starter-home-en" },
    ])
      expect((await request("/en", "POST", input)).status).toBe(400);
    expect((await request("/en", "PUT", valid)).status).toBe(400);
    expect(
      (
        await request("/en", "DELETE", {
          expectedVersion: initial.version,
          sourcePath: "old-home",
          translationId: "starter-home-en",
        })
      ).status,
    ).toBe(400);
    expect(await list()).toEqual(initial);
  });

  it("rejects unsafe, cross-language, unknown and deleted targets without mutating the registry", async () => {
    const deleted = await content.createTranslation({
      language: "en",
      path: "deleted-target",
      title: "Deleted",
      description: "",
      markdown: "body",
      tags: [],
      changeNote: "",
    });
    await content.softDelete(deleted.id, deleted.version);
    const initial = await list();
    for (const path of [
      "/home",
      "../home",
      "home?x=1",
      "home#heading",
      "https://example.com",
      "//example.com",
      "a\\b",
      "a\u0000b",
      "SEARCH",
      "search",
      "a%2fb",
      "ｈｏｍｅ",
      " spaced ",
    ])
      expect(
        (await request("/en", "POST", createInput(initial.version, path)))
          .status,
      ).toBe(400);
    for (const [translationId, status] of [
      ["starter-home-zh", 400],
      ["missing-target", 404],
      [deleted.id, 409],
    ] as const)
      expect(
        (
          await request("/en", "POST", {
            ...createInput(initial.version),
            translationId,
          })
        ).status,
      ).toBe(status);
    expect(
      (await request("/en", "POST", createInput(initial.version, "home")))
        .status,
    ).toBe(409);
    expect(await list()).toEqual(initial);
  });

  it("closes methods, path aliases and duplicate or unknown query fields", async () => {
    for (const path of [
      "/fr",
      "/%65n",
      "/en?unexpected=1",
      "/en?origin=manual&origin=automatic",
      "/en?sourcePath=home&sourcePath=other",
      "/en?origin=all",
      "/en?limit=0",
      "/en?limit=01",
      "/en?limit=51",
      "/en?limit=1.5",
      "/en?cursor=",
      "/en?sourcePath=../bad",
    ])
      expect((await request(path)).status).toBe(400);
    for (const path of ["", "/en/", "/en/extra"])
      expect((await request(path)).status).toBe(404);
    for (const method of ["PATCH", "HEAD", "OPTIONS"]) {
      const response = await request("/en", method);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST, PUT, DELETE");
    }
    for (const method of ["POST", "PUT", "DELETE"])
      expect(
        (await request("/en?limit=1", method, createInput(1))).status,
      ).toBe(400);
  });

  it("uses literal path filters and rejects cursors after filter or registry changes", async () => {
    await create("历史/a");
    await create("历史/b");
    await create("other-path");
    const first = await list("/en?origin=manual&q=%E5%8E%86%E5%8F%B2&limit=1");
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(
      `/en?origin=manual&q=%E5%8E%86%E5%8F%B2&limit=1&cursor=${first.nextCursor}`,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.path).not.toBe(first.items[0]?.path);
    expect(
      (
        await request(
          `/en?origin=manual&q=other&limit=1&cursor=${first.nextCursor}`,
        )
      ).status,
    ).toBe(400);
    expect((await list("/en?q=%25")).items).toEqual([]);
    expect((await list("/en?q=%27%20OR%201%3D1--")).items).toEqual([]);
    expect(
      (await list("/en?translationId=starter-home-en")).items,
    ).toHaveLength(3);
    await create("registry-changed");
    expect(
      (
        await request(
          `/en?origin=manual&q=%E5%8E%86%E5%8F%B2&limit=1&cursor=${first.nextCursor}`,
        )
      ).status,
    ).toBe(412);
  });

  it("bounds streamed JSON to 4 KiB and rejects malformed encodings and object shapes", async () => {
    const before = await snapshot();
    const oversized = new TextEncoder().encode(
      JSON.stringify({
        ...createInput(before.document.version),
        padding: "x".repeat(4096),
      }),
    );
    const response = await adminApi(
      new Request(`${origin}/api/admin/redirects/en`, {
        method: "POST",
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversized.subarray(0, 2048));
            controller.enqueue(oversized.subarray(2048));
            controller.close();
          },
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The request is too large.",
    });
    for (const body of [new Uint8Array([0xc3, 0x28]), "[]", "null", "{"])
      expect(
        (
          await adminApi(
            new Request(`${origin}/api/admin/redirects/en`, {
              method: "POST",
              headers,
              body,
            }),
            env,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await request("/en", "POST", createInput(before.document.version), {
          ...headers,
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/en", "POST", createInput(before.document.version), {
          ...headers,
          "Content-Length": "4097",
        })
      ).status,
    ).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("exposes closed redirect audit metadata and preserves the other audit categories", async () => {
    const created = await create();
    const update = await request("/en", "PUT", {
      ...createInput(created.version, "updated-alias"),
      sourcePath: created.item.path,
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as RedirectMutationResult;
    expect(
      (
        await request("/en", "DELETE", {
          expectedVersion: updated.version,
          sourcePath: updated.item.path,
        })
      ).status,
    ).toBe(200);
    const response = await exports.default.fetch(
      `${origin}/api/admin/audit?category=redirect&language=en&subjectId=en`,
      { headers },
    );
    expect(response.status).toBe(200);
    const audit = (await response.json()) as AuditPage;
    expect(audit.items.map((item) => item.action)).toEqual([
      "redirect.delete",
      "redirect.update",
      "redirect.create",
    ]);
    expect(audit.items.map((item) => item.details)).toEqual([
      {
        sourcePath: null,
        previousPath: "updated-alias",
        targetTranslationId: null,
        previousTarget: "starter-home-en",
      },
      {
        sourcePath: "updated-alias",
        previousPath: "old-home",
        targetTranslationId: "starter-home-en",
        previousTarget: "starter-home-en",
      },
      {
        sourcePath: "old-home",
        previousPath: null,
        targetTranslationId: "starter-home-en",
        previousTarget: null,
      },
    ]);
    expect(audit.items.map((item) => item.subjectVersion)).toEqual([
      updated.version + 1,
      updated.version,
      created.version,
    ]);
    for (const item of audit.items)
      expect(item).toMatchObject({
        category: "redirect",
        subjectId: "en",
        language: "en",
        pageTitle: null,
        origin: "current",
      });
    const serialized = JSON.stringify(audit);
    for (const value of [
      fixtureSessionToken,
      await sha256(fixtureSessionToken),
      "not-a-password-verifier",
      "fixture-owner",
      "markdown",
      "changeNote",
    ])
      expect(serialized).not.toContain(value);
    const accountResponse = await exports.default.fetch(
      `${origin}/api/admin/audit?category=administrator`,
      { headers },
    );
    expect(accountResponse.status).toBe(200);
    expect(((await accountResponse.json()) as AuditPage).items[0]?.action).toBe(
      "administrator.initialize",
    );
  });

  it("returns a generic storage failure instead of SQL or stored secrets", async () => {
    const broken = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (/redirect_|page_routes/.test(sql))
                throw new Error("SQL private redirect secret canary");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    const response = await adminApi(
      new Request(`${origin}/api/admin/redirects/en`, { headers }),
      broken,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SQL|canary|private|SELECT/);
  });
});
