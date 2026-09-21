import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminTranslation, ContentRevision } from "../shared/content";
import { MARKDOWN_LIMITS, renderMarkdown } from "../shared/markdown";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";

const origin = "https://example.com";
// Isolated local session fixture; never provisioned through deployment.
const token = "c".repeat(43);
const cookie = `__Host-wiki_session=${token}`;
let headers: Record<string, string>;
const draft = {
  title: "Private HTTP draft",
  description: "HTTP boundary fixture",
  markdown: "# Draft heading\n\nPrivate body.",
  tags: ["fixture"],
  changeNote: "Initial draft",
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO administrators(id,username,password_hash,auth_version,created_at,updated_at) VALUES(1,'test-owner','unused-local-password-fixture',1,?,?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT INTO admin_sessions(token_hash,admin_id,auth_version,created_at,expires_at,last_seen_at) VALUES(?,1,1,?,?,?)",
    ).bind(await sha256(token), now, now + 60_000, now),
  ]);
  headers = {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": await sha256(`csrf:${token}`),
  };
});

function request(
  path: string,
  method = "GET",
  input?: unknown,
  requestHeaders = headers,
) {
  return exports.default.fetch(`${origin}/api/admin${path}`, {
    method,
    headers: requestHeaders,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

async function create(
  path = "http-fixture",
  extra: Record<string, unknown> = {},
) {
  const response = await request("/pages", "POST", {
    ...draft,
    language: "zh",
    path,
    ...extra,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { translation: AdminTranslation })
    .translation;
}

async function mutation(path: string, method: string, input: unknown) {
  const response = await request(path, method, input);
  expect(response.status).toBe(200);
  return ((await response.json()) as { translation: AdminTranslation })
    .translation;
}

describe("authenticated content HTTP boundary", () => {
  it("requires a unique live administrator session for every read, write and preview", async () => {
    const page = await create();
    for (const [path, method] of [
      ["/pages", "GET"],
      ["/pages", "POST"],
      [`/pages/${page.id}`, "GET"],
      [`/pages/${page.id}/draft`, "PUT"],
      [`/pages/${page.id}/revisions`, "GET"],
      [`/pages/${page.id}/events`, "GET"],
      ["/preview", "POST"],
    ]) {
      for (const Cookie of [
        "",
        `${cookie}; ${cookie}`,
        "__Host-wiki_session=invalid",
      ]) {
        const response = await request(path as string, method, undefined, {
          Cookie,
        });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain(draft.title);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
      }
    }
    await env.DB.prepare("DELETE FROM admin_sessions").run();
    expect((await request("/pages")).status).toBe(401);
  });

  it("creates bilingual drafts and exposes complete private detail only through protected reads", async () => {
    const zh = await create("http-chinese");
    const en = await create("http-english", {
      language: "en",
      pageId: zh.pageId,
    });
    const detailResponse = await request(`/pages/${zh.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      translation: AdminTranslation;
      draft: ContentRevision;
      published: ContentRevision | null;
      translations: AdminTranslation[];
    };
    expect(detail.translation.id).toBe(zh.id);
    expect(detail.draft.markdown).toBe(draft.markdown);
    expect(detail.published).toBeNull();
    expect(detail.translations.map((item) => item.id).sort()).toEqual(
      [zh.id, en.id].sort(),
    );
    const list = (await (
      await request("/pages?language=en&status=draft&q=HTTP&limit=1")
    ).json()) as {
      items: Array<AdminTranslation & { title: string }>;
      nextCursor: string | null;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: en.id,
      title: draft.title,
      language: "en",
    });
    expect(
      (await exports.default.fetch(`${origin}/zh/http-chinese`)).status,
    ).toBe(404);
    expect(detailResponse.headers.get("Vary")).toContain("Cookie");
    expect(
      detailResponse.headers.get("Access-Control-Allow-Origin"),
    ).toBeNull();
  });

  it("saves content larger than auth JSON limits while preserving the 4 KiB credential limit", async () => {
    const page = await create();
    const markdown = `# A larger draft\n\n${"A plain sentence. ".repeat(500)}`;
    const saved = await mutation(`/pages/${page.id}/draft`, "PUT", {
      ...draft,
      markdown,
      expectedVersion: page.version,
    });
    expect(saved.version).toBe(page.version + 1);
    expect(
      (
        await request("/login", "POST", {
          username: "owner",
          password: "a".repeat(5000),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/pages", "POST", {
          ...draft,
          markdown: "a".repeat(MARKDOWN_LIMITS.sourceBytes + 1),
          language: "en",
          path: "too-large",
        })
      ).status,
    ).toBe(400);
  });

  it("publishes an explicit draft, moves, hides, deletes and restores without republishing", async () => {
    let page = await create();
    page = await mutation(`/pages/${page.id}/publish`, "POST", {
      expectedVersion: page.version,
      revisionId: page.draftRevisionId,
    });
    expect(
      (await exports.default.fetch(`${origin}/zh/http-fixture`)).status,
    ).toBe(200);
    page = await mutation(`/pages/${page.id}/move`, "POST", {
      expectedVersion: page.version,
      path: "http-moved",
    });
    const redirect = await exports.default.fetch(`${origin}/zh/http-fixture`, {
      redirect: "manual",
    });
    expect(redirect.status).toBe(301);
    page = await mutation(`/pages/${page.id}/unpublish`, "POST", {
      expectedVersion: page.version,
    });
    expect(
      (await exports.default.fetch(`${origin}/zh/http-moved`)).status,
    ).toBe(404);
    page = await mutation(`/pages/${page.id}`, "DELETE", {
      expectedVersion: page.version,
    });
    expect(page.deletedAt).not.toBeNull();
    const removed = (await (await request("/pages?status=deleted")).json()) as {
      items: AdminTranslation[];
    };
    expect(removed.items.map((item) => item.id)).toContain(page.id);
    page = await mutation(`/pages/${page.id}/restore`, "POST", {
      expectedVersion: page.version,
    });
    expect(page.deletedAt).toBeNull();
    expect(page.publishedRevisionId).toBeNull();
  });

  it("returns distinct stale-version and path-conflict statuses without advancing state", async () => {
    const first = await create("http-first");
    await create("http-occupied");
    const stale = await request(`/pages/${first.id}/draft`, "PUT", {
      ...draft,
      expectedVersion: first.version + 1,
    });
    expect(stale.status).toBe(412);
    const collision = await request(`/pages/${first.id}/move`, "POST", {
      expectedVersion: first.version,
      path: "http-occupied",
    });
    expect(collision.status).toBe(409);
    const detail = (await (await request(`/pages/${first.id}`)).json()) as {
      translation: AdminTranslation;
    };
    expect(detail.translation).toMatchObject({
      path: first.path,
      version: first.version,
    });
  });

  it("requires exact Origin and CSRF for every content mutation and Markdown preview", async () => {
    const page = await create();
    for (const [path, method] of [
      ["/pages", "POST"],
      [`/pages/${page.id}`, "DELETE"],
      [`/pages/${page.id}/draft`, "PUT"],
      ...["publish", "unpublish", "move", "restore"].map((action) => [
        `/pages/${page.id}/${action}`,
        "POST",
      ]),
      [`/pages/${page.id}/revisions/${page.draftRevisionId}/restore`, "POST"],
      ["/preview", "POST"],
    ]) {
      for (const invalid of [
        { ...headers, Origin: "https://attacker.invalid" },
        { ...headers, "X-CSRF-Token": "invalid" },
        { ...headers, "Sec-Fetch-Site": "cross-site" },
      ])
        expect(
          (await request(path as string, method, {}, invalid)).status,
        ).toBe(403);
    }
    const detail = (await (await request(`/pages/${page.id}`)).json()) as {
      translation: AdminTranslation;
    };
    expect(detail.translation.version).toBe(page.version);
  });

  it("serves immutable revisions and paginated events, restoring history as a new draft", async () => {
    let page = await create();
    const originalId = page.draftRevisionId as string;
    page = await mutation(`/pages/${page.id}/publish`, "POST", {
      expectedVersion: page.version,
      revisionId: originalId,
    });
    page = await mutation(`/pages/${page.id}/draft`, "PUT", {
      ...draft,
      markdown: "Changed private body",
      expectedVersion: page.version,
    });
    const history = (await (
      await request(`/pages/${page.id}/revisions?limit=1`)
    ).json()) as {
      revisions: Array<{ id: string; markdown?: string }>;
      nextBeforeRevision: number | null;
    };
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]?.markdown).toBeUndefined();
    expect(history.nextBeforeRevision).toBe(2);
    const earlier = (await (
      await request(`/pages/${page.id}/revisions?beforeRevision=2`)
    ).json()) as { revisions: Array<{ id: string }> };
    expect(earlier.revisions[0]?.id).toBe(originalId);
    const single = (await (
      await request(`/pages/${page.id}/revisions/${originalId}`)
    ).json()) as { revision: ContentRevision };
    expect(single.revision.markdown).toBe(draft.markdown);
    page = await mutation(
      `/pages/${page.id}/revisions/${originalId}/restore`,
      "POST",
      { expectedVersion: page.version, changeNote: "Restore snapshot" },
    );
    expect(page.publishedRevisionId).toBe(originalId);
    expect(page.draftRevisionId).not.toBe(originalId);
    const events = (await (
      await request(`/pages/${page.id}/events?limit=1`)
    ).json()) as {
      items: Array<{ type: string; version: number }>;
      nextCursor: string | null;
    };
    expect(events.items[0]).toMatchObject({
      type: "restore_revision",
      version: page.version,
    });
    expect(events.nextCursor).not.toBeNull();
    const older = (await (
      await request(
        `/pages/${page.id}/events?cursor=${encodeURIComponent(events.nextCursor ?? "")}&limit=1`,
      )
    ).json()) as { items: Array<{ version: number }> };
    expect(older.items[0]?.version).toBeLessThan(page.version);
    const other = await create("http-other");
    expect(
      (await request(`/pages/${other.id}/revisions/${originalId}`)).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/pages/${other.id}/revisions/${originalId}/restore`,
          "POST",
          { expectedVersion: other.version },
        )
      ).status,
    ).toBe(404);
  });

  it("renders preview with the same sanitized Markdown pipeline and bounds", async () => {
    const markdown =
      '# Preview\n\n<script>alert("canary")</script>\n\n<img src="x" onerror="alert(1)">\n\n[[home|Home]]';
    const response = await request("/preview", "POST", {
      language: "en",
      markdown,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await renderMarkdown(markdown, "en"));
    for (const input of [
      { language: "fr", markdown: "# Heading" },
      { language: "zh", markdown: "a".repeat(MARKDOWN_LIMITS.sourceBytes + 1) },
      { language: "zh", markdown: 12 },
      { language: "zh", markdown: "# Heading", unsafe: true },
    ])
      expect((await request("/preview", "POST", input)).status).toBe(400);
  });

  it("rejects oversized streamed bodies, invalid UTF-8 and non-object JSON", async () => {
    for (const payload of [
      new TextEncoder().encode(
        JSON.stringify({ language: "zh", markdown: "x".repeat(1024 * 1024) }),
      ),
      new Uint8Array([0xc3, 0x28]),
      new TextEncoder().encode("[]"),
      new TextEncoder().encode("null"),
    ]) {
      const response = await adminApi(
        new Request(`${origin}/api/admin/preview`, {
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
    const tooLong = await request(
      "/preview",
      "POST",
      {},
      { ...headers, "Content-Length": String(1024 * 1024 + 1) },
    );
    expect(tooLong.status).toBe(400);
  });

  it("validates exact schemas, query keys, identifiers and methods", async () => {
    const page = await create();
    for (const query of [
      "language=fr",
      "status=all",
      "limit=0",
      "limit=51",
      "limit=1.5",
      "limit=1&limit=2",
      "offset=0",
      "cursor=",
      `q=${"x".repeat(201)}`,
    ]) {
      expect((await request(`/pages?${query}`)).status).toBe(400);
    }
    for (const input of [
      { ...draft, language: "zh", path: "extra", admin: true },
      { ...draft, language: "zh", path: "missing", tags: [1] },
    ])
      expect((await request("/pages", "POST", input)).status).toBe(400);
    expect(
      (
        await request(`/pages/${page.id}/draft`, "PUT", {
          ...draft,
          expectedVersion: "1",
        })
      ).status,
    ).toBe(400);
    expect((await request(`/pages/${page.id}?unexpected=1`)).status).toBe(400);
    expect(
      (await request(`/pages/${page.id}/revisions?beforeRevision=-1`)).status,
    ).toBe(400);
    expect((await request(`/pages/${page.id}/events?limit=100`)).status).toBe(
      400,
    );
    expect((await request("/pages/invalid%2fid")).status).toBe(400);
    expect((await request("/pages/invalid%252fid")).status).toBe(400);
    expect((await request("/pages/starter%2Dhome%2Dzh")).status).toBe(200);
    expect((await request(`/pages/${page.id}/unknown`)).status).toBe(404);
    for (const [path, method, allow] of [
      ["/pages", "PATCH", "GET, POST"],
      [`/pages/${page.id}/draft`, "POST", "PUT"],
      [`/pages/${page.id}/publish`, "GET", "POST"],
      ["/preview", "GET", "POST"],
    ]) {
      const response = await request(path as string, method);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe(allow);
    }
  });

  it("returns a generic storage failure without SQL, request content or credentials", async () => {
    const broken = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (/page_translations/.test(sql))
                throw new Error("SQL private content credential canary");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    const response = await adminApi(
      new Request(`${origin}/api/admin/pages`, { headers }),
      broken,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Administration temporarily unavailable",
    });
  });
});
