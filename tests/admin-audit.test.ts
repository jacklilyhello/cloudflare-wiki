import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditPage } from "../shared/audit";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";
import { ContentService } from "../worker/content/service";
import { NavigationService } from "../worker/navigation/service";

const origin = "https://example.com";
// Local isolated bearer fixture; never used by deployment or a real account.
const token = "a".repeat(43);
const cookie = `__Host-wiki_session=${token}`;
const headers = { Cookie: cookie };
const draft = {
  title: "Audit HTTP private title",
  description: "Private metadata",
  markdown: "PRIVATE MARKDOWN BODY CANARY",
  tags: [],
  changeNote: "PRIVATE CHANGE NOTE CANARY",
};
let content: ContentService;
let navigation: NavigationService;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const now = Date.now();
  const tokenHash = await sha256(token);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO administrators(id,username,password_hash,auth_version,created_at,updated_at) VALUES(1,'private-owner-canary','unused-local-password-fixture',1,?,?)",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT INTO admin_sessions(token_hash,admin_id,auth_version,created_at,expires_at,last_seen_at) VALUES(?,1,1,?,?,?)",
    ).bind(tokenHash, now, now + 60_000, now),
  ]);
  const access = { tokenHash, authVersion: 1 };
  content = new ContentService(env.DB, access);
  navigation = new NavigationService(env.DB, access);
});

function request(path = "/audit", method = "GET", requestHeaders = headers) {
  return exports.default.fetch(`${origin}/api/admin${path}`, {
    method,
    headers: requestHeaders,
  });
}

async function list(query = "") {
  const response = await request(`/audit${query ? `?${query}` : ""}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AuditPage;
}

async function create(language: "zh" | "en" = "en") {
  return content.createTranslation({
    ...draft,
    language,
    path: `audit-${crypto.randomUUID()}`,
  });
}

describe("administrator audit HTTP boundary", () => {
  it("requires an unambiguous live session before routing or parsing filters", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"])
      for (const Cookie of [
        "",
        `${cookie}; ${cookie}`,
        "__Host-wiki_session=invalid",
      ]) {
        const response = await request("/audit?category=invalid", method, {
          Cookie,
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Sign in required" });
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
      }
    await env.DB.prepare("DELETE FROM admin_sessions").run();
    expect((await request()).status).toBe(401);
  });

  it("lists typed page, navigation and account events without source bodies or credentials", async () => {
    const en = await create();
    const zh = await create("zh");
    await navigation.save("zh", {
      expectedVersion: 1,
      mode: "custom",
      nodes: [],
    });
    const page = await list(
      `category=page&action=page.create&language=en&subjectId=${en.id}`,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      category: "page",
      action: "page.create",
      subjectId: en.id,
      language: "en",
      origin: "current",
      subjectVersion: 1,
    });
    expect((await list(`language=zh&subjectId=${zh.id}`)).items).toHaveLength(
      1,
    );
    const nav = await list(
      "category=navigation&action=navigation.save&language=zh",
    );
    expect(nav.items).toHaveLength(1);
    expect(nav.items[0]).toMatchObject({
      category: "navigation",
      action: "navigation.save",
      language: "zh",
      details: { previousMode: "automatic", mode: "custom", nodeCount: 0 },
    });
    const administrator = await list("category=administrator&language=site");
    expect(administrator.items).toHaveLength(1);
    expect(administrator.items[0]).toMatchObject({
      category: "administrator",
      action: "administrator.initialize",
      language: null,
    });
    const serialized = JSON.stringify(await list("limit=50"));
    for (const privateValue of [
      draft.markdown,
      draft.changeNote,
      "private-owner-canary",
      "unused-local-password-fixture",
      token,
      await sha256(token),
    ])
      expect(serialized).not.toContain(privateValue);
    expect(serialized).not.toMatch(
      /"(?:markdown|password_hash|token_hash|csrfToken|username)"/,
    );
  });

  it("uses a default 25-item page and stable descending cursors despite new events", async () => {
    let version = 1;
    for (let index = 0; index < 28; index++) {
      const saved = await navigation.save("en", {
        expectedVersion: version,
        mode: index % 2 ? "automatic" : "custom",
        nodes: [],
      });
      version = saved.version;
    }
    const first = await list("category=navigation&language=en");
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    await navigation.save("en", {
      expectedVersion: version,
      mode: "custom",
      nodes: [],
    });
    const cursor = encodeURIComponent(first.nextCursor ?? "");
    const second = await list(
      `category=navigation&language=en&cursor=${cursor}&limit=50`,
    );
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const seqs = [...first.items, ...second.items].map((item) => item.seq);
    expect(new Set(seqs).size).toBe(28);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(
      (await request(`/audit?category=navigation&language=zh&cursor=${cursor}`))
        .status,
    ).toBe(400);
    expect(
      (await request(`/audit?category=page&language=en&cursor=${cursor}`))
        .status,
    ).toBe(400);
  });

  it("accepts canonical inclusive-from/exclusive-to bounds", async () => {
    const page = await create();
    const initial = await list(`subjectId=${page.id}`);
    const createdAt = initial.items[0]?.createdAt;
    expect(createdAt).toBeDefined();
    const nextMillisecond = new Date(
      Date.parse(createdAt ?? "") + 1,
    ).toISOString();
    const inside = new URLSearchParams({
      subjectId: page.id,
      from: createdAt ?? "",
      to: nextMillisecond,
    });
    expect((await list(inside.toString())).items).toHaveLength(1);
    const exclusive = new URLSearchParams({
      subjectId: page.id,
      to: createdAt ?? "",
    });
    expect((await list(exclusive.toString())).items).toHaveLength(0);
    const after = new URLSearchParams({
      subjectId: page.id,
      from: nextMillisecond,
    });
    expect((await list(after.toString())).items).toHaveLength(0);
  });

  it("rejects unknown, repeated, coercible and mismatched filters", async () => {
    for (const query of [
      "offset=0",
      "category=page&category=navigation",
      "language=zh&language=zh",
      "category=all",
      "category=",
      "action=page.unknown",
      "action=",
      "language=fr",
      "language=",
      "category=page&action=navigation.save",
      "category=navigation&action=administrator.initialize",
      "limit=0",
      "limit=51",
      "limit=-1",
      "limit=1.5",
      "limit=01",
      "limit=1e1",
      "limit=",
      "limit=1&limit=2",
      "subjectId=",
      "subjectId=a%2Fb",
      "subjectId=a%252Fb",
      `subjectId=${"x".repeat(129)}`,
      "from=",
      "from=2026-09-21",
      "from=2026-09-21T00%3A00%3A00Z",
      "from=2026-02-30T00%3A00%3A00.000Z",
      "to=2026-09-21T00%3A00%3A00.000%2B00%3A00",
      "from=2026-09-21T00%3A00%3A00.000Z&to=2026-09-21T00%3A00%3A00.000Z",
      "from=2026-09-22T00%3A00%3A00.000Z&to=2026-09-21T00%3A00%3A00.000Z",
      "cursor=",
      "cursor=malformed",
      `cursor=${"a".repeat(2049)}`,
    ])
      expect((await request(`/audit?${query}`)).status).toBe(400);
    expect((await list("subjectId=nonexistent-subject")).items).toEqual([]);
  });

  it("serves only the exact read route with strict private response headers", async () => {
    const before = await list("limit=50");
    for (const method of [
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]) {
      const response = await request("/audit", method);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET");
    }
    for (const path of [
      "/audit/",
      "/audit/1",
      "/audit/export",
      "/audit/delete",
    ])
      expect((await request(path)).status).toBe(404);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Content-Security-Policy")).not.toMatch(
      /unsafe-inline|unsafe-eval/,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.json()).toEqual(before);
    expect(await list("limit=50")).toEqual(before);
  });

  it("does not expose database details when audit storage fails", async () => {
    const broken = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (/audit_records/.test(sql))
                throw new Error("SQL audit private credential canary");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    const response = await adminApi(
      new Request(`${origin}/api/admin/audit`, { headers }),
      broken,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).not.toMatch(/SQL|canary|credential/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
