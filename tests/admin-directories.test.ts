import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminTranslation, ContentDetail } from "../shared/content";
import type { Language } from "../shared/contracts";
import {
  DIRECTORY_LIMITS,
  type DirectoryMoveCommit,
  type DirectoryMovePreview,
  type DirectoryMoveResult,
  type PageDirectory,
} from "../shared/directories";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";
import { AuthService } from "../worker/auth/service";
import { fixtureSessionToken, seedContentAccess } from "./content-fixture";

const origin = "https://example.com";
const cookie = `__Host-wiki_session=${fixtureSessionToken}`;
const draft = {
  title: "Private directory title",
  description: "Local directory HTTP fixture",
  markdown: "# Published directory fixture\n\nThe original body.",
  tags: ["directory"],
  changeNote: "Local fixture",
};
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
afterEach(() => vi.restoreAllMocks());

function request(
  path: string,
  method = "GET",
  input?: unknown,
  selected: Record<string, string> = headers,
) {
  return exports.default.fetch(`${origin}/api/admin${path}`, {
    method,
    headers: selected,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

async function create(
  path: string,
  language: Language = "zh",
  extra: Record<string, unknown> = {},
) {
  const response = await request("/pages", "POST", {
    ...draft,
    language,
    path,
    ...extra,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { translation: AdminTranslation })
    .translation;
}

async function mutate(path: string, method: string, body: unknown) {
  const response = await request(path, method, body);
  expect(response.status).toBe(200);
  return ((await response.json()) as { translation: AdminTranslation })
    .translation;
}

async function detail(id: string) {
  const response = await request(`/pages/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ContentDetail;
}

async function browse(path = "", query: Record<string, string> = {}) {
  const params = new URLSearchParams({ path, ...query });
  const response = await request(`/directories/zh?${params}`);
  expect(response.status).toBe(200);
  return (await response.json()) as PageDirectory;
}

async function preview(fromPath = "http-dir", toPath = "http-moved") {
  const response = await request("/directories/zh/preview", "POST", {
    fromPath,
    toPath,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as DirectoryMovePreview;
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

async function snapshot() {
  return Promise.all(
    [
      "page_translations",
      "page_routes",
      "page_events",
      "audit_records",
      "published_search",
    ].map(
      async (table) =>
        (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
          .results,
    ),
  );
}

describe("directory HTTP boundary", () => {
  it("authenticates all routes before parsing methods, queries or private input", async () => {
    await create("http-dir");
    for (const path of [
      "/directories/zh",
      "/directories/en?unexpected=1",
      "/directories/zh/preview",
      "/directories/zh/move",
      "/directories/fr/unknown",
    ])
      for (const method of ["GET", "POST", "DELETE"])
        for (const Cookie of [
          "",
          `${cookie}; ${cookie}`,
          "__Host-wiki_session=invalid",
        ]) {
          const response = await request(path, method, undefined, { Cookie });
          expect(response.status).toBe(401);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
          expect(
            response.headers.get("Access-Control-Allow-Origin"),
          ).toBeNull();
          expect(await response.text()).not.toContain(draft.title);
        }
    await env.DB.prepare("DELETE FROM admin_sessions").run();
    for (const path of ["", "/preview", "/move"])
      expect(
        (await request(`/directories/zh${path}`, path ? "POST" : "GET")).status,
      ).toBe(401);
  });

  it("lists direct children, dual nodes, landing pages and separate language trees", async () => {
    const landing = await create("http-dir");
    const child = await create("http-dir/child");
    await create("http-dir/child/deep");
    await create("http-dir/folder/leaf");
    await create("http-directory/outside");
    const english = await create("http-dir/english", "en");
    const deleted = await create("http-dir/deleted");
    await mutate(`/pages/${deleted.id}`, "DELETE", {
      expectedVersion: deleted.version,
    });
    const root = await browse();
    expect(root).toMatchObject({ language: "zh", path: "", page: null });
    expect(root.version).toBeGreaterThan(0);
    expect(root.items.find((item) => item.path === "http-dir")).toMatchObject({
      segment: "http-dir",
      hasChildren: true,
      page: { id: landing.id, title: draft.title },
    });
    const folder = await browse("http-dir");
    expect(folder.page?.id).toBe(landing.id);
    expect(folder.items).toEqual([
      expect.objectContaining({
        path: "http-dir/child",
        segment: "child",
        hasChildren: true,
        page: expect.objectContaining({ id: child.id }),
      }),
      {
        path: "http-dir/folder",
        segment: "folder",
        hasChildren: true,
        page: null,
      },
    ]);
    expect(folder.nextCursor).toBeNull();
    const enResponse = await request("/directories/en?path=http-dir");
    expect(enResponse.status).toBe(200);
    const en = (await enResponse.json()) as PageDirectory;
    expect(en.page).toBeNull();
    expect(en.items.map((item) => item.page?.id)).toEqual([english.id]);
    expect(enResponse.headers.get("Vary")).toContain("Cookie");
    expect(JSON.stringify(folder)).not.toContain(draft.markdown);
    expect((await request("/directories/zh?path=not-created")).status).toBe(
      404,
    );
    const leaf = await browse("http-dir/child/deep");
    expect(leaf.page?.path).toBe("http-dir/child/deep");
    expect(leaf.items).toEqual([]);
  });

  it("accepts canonical Unicode prefixes and bounds continuation to its original scope", async () => {
    await create("指南/安装");
    await create("指南/配置");
    await create("指南/问题");
    const first = await browse("指南", { limit: "1" });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await browse("指南", {
      limit: "1",
      cursor: first.nextCursor as string,
    });
    expect(second.version).toBe(first.version);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.path).not.toBe(first.items[0]?.path);
    for (const path of [
      `/directories/zh?path=&limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      `/directories/en?path=${encodeURIComponent("指南")}&limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    ])
      expect((await request(path)).status).toBe(400);
    await create("指南/新增");
    expect(
      (
        await request(
          `/directories/zh?path=${encodeURIComponent("指南")}&limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
        )
      ).status,
    ).toBe(412);
    expect((await browse("指南", { limit: "50" })).items).toHaveLength(4);
  });

  it("requires exact Origin and CSRF for both preview and move without changing content", async () => {
    await create("http-dir");
    const move = commit(await preview());
    const before = await snapshot();
    const invalidHeaders: Record<string, string>[] = [
      { ...headers, Origin: "https://outside.example" },
      { ...headers, Origin: `${origin}/` },
      { ...headers, Origin: "" },
      { ...headers, "X-CSRF-Token": "invalid" },
      { ...headers, "X-CSRF-Token": "" },
      { ...headers, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const action of ["preview", "move"])
      for (const selected of invalidHeaders)
        expect(
          (await request(`/directories/zh/${action}`, "POST", move, selected))
            .status,
        ).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect(
      (await request("/directories/zh", "GET", undefined, { Cookie: cookie }))
        .status,
    ).toBe(200);
  });

  it("moves the entire reviewed active subtree while retaining publication, identity, aliases and Trash", async () => {
    let landing = await create("http-dir");
    let child = await create("http-original-child");
    child = await mutate(`/pages/${child.id}/move`, "POST", {
      expectedVersion: child.version,
      path: "http-dir/child",
    });
    landing = await mutate(`/pages/${landing.id}/publish`, "POST", {
      expectedVersion: landing.version,
      revisionId: landing.draftRevisionId,
    });
    child = await mutate(`/pages/${child.id}/publish`, "POST", {
      expectedVersion: child.version,
      revisionId: child.draftRevisionId,
    });
    child = await mutate(`/pages/${child.id}/draft`, "PUT", {
      ...draft,
      title: "Unpublished replacement title",
      markdown: "Private replacement must stay hidden.",
      expectedVersion: child.version,
    });
    const privatePage = await create("http-dir/private");
    let deleted = await create("http-dir/deleted");
    deleted = await mutate(`/pages/${deleted.id}`, "DELETE", {
      expectedVersion: deleted.version,
    });
    const english = await create("http-dir", "en", { pageId: landing.pageId });
    const beforePreview = await snapshot();
    const planned = await preview();
    expect(await snapshot()).toEqual(beforePreview);
    expect(planned).toMatchObject({
      language: "zh",
      fromPath: "http-dir",
      toPath: "http-moved",
      publishedCount: 2,
    });
    expect(planned.members.map((member) => member.id).sort()).toEqual(
      [landing.id, child.id, privatePage.id].sort(),
    );
    expect(
      planned.members.find((member) => member.id === landing.id),
    ).toMatchObject({
      version: landing.version,
      fromPath: "http-dir",
      toPath: "http-moved",
      published: true,
    });
    const response = await request(
      "/directories/zh/move",
      "POST",
      commit(planned),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as DirectoryMoveResult;
    expect(result.version).toBeGreaterThan(planned.version);
    expect(result.items).toHaveLength(3);
    for (const old of [landing, child, privatePage]) {
      const expectedPath = old.path.replace(/^http-dir(?=\/|$)/, "http-moved");
      const current = await detail(old.id);
      expect(current.translation).toMatchObject({
        id: old.id,
        pageId: old.pageId,
        path: expectedPath,
        version: old.version + 1,
        draftRevisionId: old.draftRevisionId,
        publishedRevisionId: old.publishedRevisionId,
      });
      expect(result.items.find((item) => item.id === old.id)).toEqual(
        current.translation,
      );
    }
    expect((await detail(child.id)).draft.markdown).toBe(
      "Private replacement must stay hidden.",
    );
    expect((await detail(deleted.id)).translation).toEqual(deleted);
    expect((await detail(english.id)).translation).toEqual(english);
    for (const [oldPath, newPath] of [
      ["http-dir", "http-moved"],
      ["http-dir/child", "http-moved/child"],
      ["http-original-child", "http-moved/child"],
    ]) {
      const redirect = await exports.default.fetch(`${origin}/zh/${oldPath}`, {
        redirect: "manual",
      });
      expect(redirect.status).toBe(301);
      expect(
        new URL(redirect.headers.get("Location") ?? "", origin).pathname,
      ).toBe(`/zh/${newPath}`);
    }
    const published = await exports.default.fetch(
      `${origin}/zh/http-moved/child`,
    );
    expect(published.status).toBe(200);
    const html = await published.text();
    expect(html).toContain("The original body.");
    expect(html).not.toContain("Private replacement must stay hidden.");
    for (const path of [
      "http-dir/private",
      "http-moved/private",
      "http-dir/deleted",
    ])
      expect((await exports.default.fetch(`${origin}/zh/${path}`)).status).toBe(
        404,
      );
  });

  it("returns 412 for changed registry or members and never partially commits", async () => {
    const page = await create("http-dir");
    await create("http-dir/child");
    const planned = await preview();
    const body = commit(planned);
    const before = await snapshot();
    for (const invalid of [
      { ...body, expectedVersion: body.expectedVersion + 1 },
      {
        ...body,
        expectedMembers: body.expectedMembers.map((member) => ({
          ...member,
          version: member.version + 1,
        })),
      },
      { ...body, expectedMembers: body.expectedMembers.slice(1) },
    ])
      expect(
        (await request("/directories/zh/move", "POST", invalid)).status,
      ).toBe(412);
    expect(await snapshot()).toEqual(before);
    await mutate(`/pages/${page.id}/draft`, "PUT", {
      ...draft,
      title: "Changed after review",
      expectedVersion: page.version,
    });
    const changed = await snapshot();
    expect((await request("/directories/zh/move", "POST", body)).status).toBe(
      412,
    );
    expect(await snapshot()).toEqual(changed);
    expect((await detail(page.id)).translation.path).toBe("http-dir");
  });

  it("returns conflicts for occupied destination routes and preserves empty-source errors", async () => {
    await create("http-dir");
    const occupied = await create("http-occupied/private");
    const trashed = await create("http-trash/child");
    await mutate(`/pages/${trashed.id}`, "DELETE", {
      expectedVersion: trashed.version,
    });
    await mutate(`/pages/${occupied.id}/move`, "POST", {
      expectedVersion: occupied.version,
      path: "http-current/private",
    });
    const before = await snapshot();
    for (const toPath of ["http-occupied", "http-current", "http-trash"])
      expect(
        (
          await request("/directories/zh/preview", "POST", {
            fromPath: "http-dir",
            toPath,
          })
        ).status,
      ).toBe(409);
    expect(
      (
        await request("/directories/zh/preview", "POST", {
          fromPath: "http-absent",
          toPath: "http-free",
        })
      ).status,
    ).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unknown or duplicate query fields and noncanonical pagination", async () => {
    for (const query of [
      "unknown=1",
      "language=zh",
      "q=private",
      "path=a&path=b",
      "limit=1&limit=2",
      "cursor=a&cursor=b",
      "limit=",
      "limit=0",
      "limit=51",
      "limit=-1",
      "limit=1.5",
      "limit=01",
      "limit=9007199254740992",
      "cursor=",
      "cursor=invalid!",
      `cursor=${"a".repeat(DIRECTORY_LIMITS.cursor + 1)}`,
    ])
      expect((await request(`/directories/zh?${query}`)).status).toBe(400);
    for (const action of ["preview", "move"])
      for (const query of ["path=a", "limit=1", "unknown=1", "path=a&path=a"])
        expect(
          (await request(`/directories/zh/${action}?${query}`, "POST", {}))
            .status,
        ).toBe(400);
  });

  it("rejects invalid path/language values without reflecting supplied content", async () => {
    for (const path of [
      "/leading",
      "trailing/",
      "double//slash",
      "dot/../path",
      "Upper",
      "ｆｏｌｄｅｒ",
      "contains space",
      "admin/hidden",
      "a\\b",
      "a%2fb",
      "x".repeat(241),
      "<script>private-path-canary</script>",
    ]) {
      const response = await request(
        `/directories/zh?path=${encodeURIComponent(path)}`,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private-path-canary");
      for (const field of ["fromPath", "toPath"])
        expect(
          (
            await request("/directories/zh/preview", "POST", {
              fromPath: "http-dir",
              toPath: "http-moved",
              [field]: path,
            })
          ).status,
        ).toBe(400);
    }
    for (const language of ["fr", "ZH", "%7A%68", "zh%2Fen"])
      expect((await request(`/directories/${language}`)).status).toBe(400);
    for (const input of [
      { fromPath: "", toPath: "target" },
      { fromPath: "source", toPath: "" },
      { fromPath: "same", toPath: "same" },
      { fromPath: "source", toPath: "source/child" },
      { fromPath: "source/child", toPath: "source" },
    ])
      expect(
        (await request("/directories/zh/preview", "POST", input)).status,
      ).toBe(400);
  });

  it("requires closed preview and commit objects with a bounded unique member manifest", async () => {
    await create("http-dir");
    const input = commit(await preview());
    for (const body of [
      {},
      { fromPath: "http-dir" },
      { fromPath: 1, toPath: "target" },
      { fromPath: "http-dir", toPath: null },
      { fromPath: "http-dir", toPath: "target", expectedVersion: 1 },
    ])
      expect(
        (await request("/directories/zh/preview", "POST", body)).status,
      ).toBe(400);
    const member = input.expectedMembers[0];
    for (const body of [
      { fromPath: input.fromPath, toPath: input.toPath },
      { ...input, unsafe: true },
      { ...input, expectedVersion: "1" },
      { ...input, expectedVersion: 0 },
      { ...input, expectedVersion: 1.5 },
      { ...input, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, expectedMembers: null },
      { ...input, expectedMembers: [] },
      { ...input, expectedMembers: [null] },
      { ...input, expectedMembers: [member, member] },
      {
        ...input,
        expectedMembers: [{ ...member, title: "private-extra-canary" }],
      },
      { ...input, expectedMembers: [{ id: member?.id }] },
      { ...input, expectedMembers: [{ id: "invalid/id", version: 1 }] },
      { ...input, expectedMembers: [{ id: member?.id, version: "1" }] },
      { ...input, expectedMembers: [{ id: member?.id, version: 0 }] },
      {
        ...input,
        expectedMembers: Array.from(
          { length: DIRECTORY_LIMITS.move + 1 },
          () => ({ id: crypto.randomUUID(), version: 1 }),
        ),
      },
    ]) {
      const response = await request("/directories/zh/move", "POST", body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private-extra-canary");
    }
  });

  it("rejects non-JSON, malformed UTF-8, non-object and streamed oversized bodies on both POST routes", async () => {
    const encoder = new TextEncoder();
    for (const action of ["preview", "move"]) {
      for (const payload of [
        new Uint8Array([0xc3, 0x28]),
        encoder.encode("[]"),
        encoder.encode("null"),
        encoder.encode("{"),
        encoder.encode(
          JSON.stringify({
            fromPath: "a",
            toPath: "b",
            padding: "x".repeat(DIRECTORY_LIMITS.bodyBytes),
          }),
        ),
      ]) {
        const response = await adminApi(
          new Request(`${origin}/api/admin/directories/zh/${action}`, {
            method: "POST",
            headers,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(payload);
                controller.close();
              },
            }),
          }),
          env,
        );
        expect(response.status).toBe(400);
      }
      expect(
        (
          await request(
            `/directories/zh/${action}`,
            "POST",
            {},
            { ...headers, "Content-Type": "text/plain" },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            `/directories/zh/${action}`,
            "POST",
            {},
            {
              ...headers,
              "Content-Length": String(DIRECTORY_LIMITS.bodyBytes + 1),
            },
          )
        ).status,
      ).toBe(400);
      expect((await request(`/directories/zh/${action}`, "POST")).status).toBe(
        400,
      );
    }
  });

  it("distinguishes exact routes from unsupported methods", async () => {
    for (const path of [
      "/directories",
      "/directories/",
      "/directories/zh/",
      "/directories/zh/unknown",
      "/directories/zh/move/extra",
      "/directories-extra/zh",
    ])
      expect((await request(path)).status).toBe(404);
    for (const [path, allowed, methods] of [
      [
        "/directories/zh",
        "GET",
        ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
      ],
      [
        "/directories/zh/preview",
        "POST",
        ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"],
      ],
      [
        "/directories/en/move",
        "POST",
        ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"],
      ],
    ] as const)
      for (const method of methods) {
        const response = await request(path, method);
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe(allowed);
      }
  });

  it("accepts valid JSON at exactly 16 KiB and cancels an oversized streamed body", async () => {
    await create("http-dir");
    const input = commit(await preview());
    const encoder = new TextEncoder();
    for (const action of ["preview", "move"]) {
      const body = JSON.stringify(
        action === "preview"
          ? { fromPath: input.fromPath, toPath: input.toPath }
          : input,
      );
      const padding = " ".repeat(
        DIRECTORY_LIMITS.bodyBytes - encoder.encode(body).byteLength,
      );
      let cancelled = false;
      const oversized = await adminApi(
        new Request(`${origin}/api/admin/directories/zh/${action}`, {
          method: "POST",
          headers,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(body));
              controller.enqueue(encoder.encode(`${padding} `));
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
        env,
      );
      expect(oversized.status).toBe(400);
      expect(await oversized.json()).toEqual({
        error: "The request is too large.",
      });
      expect(cancelled).toBe(true);
      const accepted = await adminApi(
        new Request(`${origin}/api/admin/directories/zh/${action}`, {
          method: "POST",
          headers,
          body: `${body}${padding}`,
        }),
        env,
      );
      expect(accepted.status).toBe(200);
    }
  });

  it.each(["list", "preview", "move"] as const)(
    "rechecks SQL access after HTTP authentication for %s",
    async (operation) => {
      await create("http-dir");
      const input = commit(await preview());
      const before = await snapshot();
      const original = AuthService.prototype.getSession;
      const checked = vi
        .spyOn(AuthService.prototype, "getSession")
        .mockImplementation(async function (this: AuthService, token) {
          const session = await original.call(this, token);
          await env.DB.prepare("DELETE FROM admin_sessions").run();
          return session;
        });
      const suffix = operation === "list" ? "?path=http-dir" : `/${operation}`;
      const body =
        operation === "preview"
          ? { fromPath: input.fromPath, toPath: input.toPath }
          : input;
      const response = await adminApi(
        new Request(`${origin}/api/admin/directories/zh${suffix}`, {
          method: operation === "list" ? "GET" : "POST",
          headers,
          ...(operation === "list" ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
      expect(checked).toHaveBeenCalledOnce();
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(draft.title);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["list", "preview", "move"] as const)(
    "sanitizes storage failures during %s",
    async (operation) => {
      await create("http-dir");
      const input = commit(await preview());
      const broken = {
        ...env,
        DB: new Proxy(env.DB, {
          get(target, property) {
            if (property === "prepare")
              return (sql: string) => {
                if (/page_translations|page_routes|route_registries/.test(sql))
                  throw new Error("SQL directory credential private-canary");
                return target.prepare(sql);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      } as Env;
      const suffix = operation === "list" ? "" : `/${operation}`;
      const body =
        operation === "preview"
          ? { fromPath: input.fromPath, toPath: input.toPath }
          : input;
      const response = await adminApi(
        new Request(`${origin}/api/admin/directories/zh${suffix}`, {
          method: operation === "list" ? "GET" : "POST",
          headers,
          ...(operation === "list" ? {} : { body: JSON.stringify(body) }),
        }),
        broken,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Administration temporarily unavailable",
      });
    },
  );
});
