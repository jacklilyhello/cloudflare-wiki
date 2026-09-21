import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { NavigationDocument, NavigationNode } from "../shared/navigation";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";

const origin = "https://example.com";
// This isolated local bearer is never provisioned outside the test database.
const token = "n".repeat(43);
const cookie = `__Host-wiki_session=${token}`;
let headers: Record<string, string>;

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
  path = "/zh",
  method = "GET",
  input?: unknown,
  requestHeaders = headers,
) {
  return exports.default.fetch(`${origin}/api/admin/navigation${path}`, {
    method,
    headers: requestHeaders,
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

async function get(language = "zh") {
  const response = await request(`/${language}`);
  expect(response.status).toBe(200);
  return (await response.json()) as NavigationDocument;
}

function node(extra: Partial<NavigationNode> = {}): NavigationNode {
  return {
    id: "home-link",
    parentId: null,
    position: 0,
    kind: "page",
    label: null,
    translationId: "starter-home-zh",
    externalUrl: null,
    ...extra,
  };
}

function persisted({
  language,
  version,
  mode,
  nodes,
  updatedAt,
}: NavigationDocument) {
  return { language, version, mode, nodes, updatedAt };
}

function input(expectedVersion: number, nodes: NavigationNode[] = []) {
  return { expectedVersion, mode: "custom", nodes };
}

describe("authenticated navigation HTTP boundary", () => {
  it("requires one live session for every read and write before dispatch", async () => {
    for (const path of ["/zh", "/en", "/fr", "/zh/unknown"])
      for (const method of ["GET", "PUT"])
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
    expect((await request("/zh", "PUT", input(1))).status).toBe(401);
  });

  it("reads independent automatic trees and keeps response policies strict", async () => {
    for (const language of ["zh", "en"]) {
      const response = await request(`/${language}`);
      expect(response.status).toBe(200);
      const tree = (await response.json()) as NavigationDocument;
      expect(tree).toMatchObject({
        language,
        version: 1,
        mode: "automatic",
        nodes: [],
      });
      expect(tree.automaticNodes?.length).toBeGreaterThan(0);
      for (const item of tree.automaticNodes ?? [])
        if (item.translationId)
          expect(item.translationId).toMatch(new RegExp(`-${language}$`));
      expect(response.headers.get("Content-Security-Policy")).not.toMatch(
        /unsafe-inline|unsafe-eval/,
      );
      expect(response.headers.get("Vary")).toContain("Cookie");
    }
  });

  it("saves mixed nodes, preserves a custom draft in automatic mode and accepts an explicit empty tree", async () => {
    const initial = await get();
    const nodes = [
      node({ id: "folder", kind: "group", label: "入门", translationId: null }),
      node({ parentId: "folder" }),
      node({
        id: "external",
        kind: "link",
        position: 1,
        label: "Project",
        translationId: null,
        externalUrl: "https://example.com/docs",
      }),
    ];
    let response = await request("/zh", "PUT", input(initial.version, nodes));
    expect(response.status).toBe(200);
    let saved = (await response.json()) as NavigationDocument;
    expect(saved).toMatchObject({
      language: "zh",
      mode: "custom",
      version: initial.version + 1,
    });
    expect(saved.nodes).toHaveLength(3);
    expect((await get("en")).mode).toBe("automatic");
    response = await request("/zh", "PUT", {
      expectedVersion: saved.version,
      mode: "automatic",
      nodes: saved.nodes,
    });
    expect(response.status).toBe(200);
    saved = (await response.json()) as NavigationDocument;
    expect(saved.mode).toBe("automatic");
    expect(saved.nodes).toHaveLength(3);
    expect(saved.automaticNodes?.length).toBeGreaterThan(0);
    response = await request("/zh", "PUT", input(saved.version));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      mode: "custom",
      nodes: [],
    });
  });

  it("returns 412 for stale saves without discarding the winner", async () => {
    const initial = await get();
    const response = await request(
      "/zh",
      "PUT",
      input(initial.version, [node()]),
    );
    expect(response.status).toBe(200);
    const saved = (await response.json()) as NavigationDocument;
    expect((await request("/zh", "PUT", input(initial.version))).status).toBe(
      412,
    );
    expect(await get()).toMatchObject(persisted(saved));
  });

  it("requires exact same-origin and the verified session CSRF token for writes", async () => {
    const initial = await get();
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: "" },
      { Origin: "https://attacker.invalid" },
      { Origin: `${origin}/` },
      { "Sec-Fetch-Site": "cross-site" },
      { "X-CSRF-Token": "" },
      { "X-CSRF-Token": "wrong" },
    ];
    for (const overrides of rejectedHeaders)
      expect(
        (
          await request("/zh", "PUT", input(initial.version), {
            ...headers,
            ...overrides,
          })
        ).status,
      ).toBe(403);
    expect(await get()).toMatchObject(persisted(initial));
    expect(
      (await request("/zh", "GET", undefined, { Cookie: cookie })).status,
    ).toBe(200);
  });

  it("rejects unknown fields, coercions, incomplete nodes and invalid versions", async () => {
    const initial = await get();
    const valid = input(initial.version, [node()]);
    const { externalUrl: _unused, ...incomplete } = node();
    const malformed = [
      { ...valid, unexpected: true },
      { expectedVersion: initial.version, nodes: [] },
      { ...valid, expectedVersion: "1" },
      { ...valid, expectedVersion: 0 },
      { ...valid, expectedVersion: 1.5 },
      { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, mode: "auto" },
      { ...valid, nodes: null },
      { ...valid, nodes: [incomplete] },
      { ...valid, nodes: [{ ...node(), extra: true }] },
      { ...valid, nodes: [null] },
      { ...valid, nodes: [{ ...node(), kind: ["page"] }] },
      { ...valid, nodes: [{ ...node(), position: "0" }] },
      { ...valid, nodes: [{ ...node(), parentId: 1 }] },
      { ...valid, nodes: [{ ...node(), label: {} }] },
    ];
    for (const value of malformed)
      expect((await request("/zh", "PUT", value)).status).toBe(400);
    expect(await get()).toMatchObject(persisted(initial));
  });

  it("maps service path, language and graph validation errors without saving", async () => {
    const initial = await get();
    expect(
      (
        await request(
          "/zh",
          "PUT",
          input(initial.version, [node({ translationId: "missing-page" })]),
        )
      ).status,
    ).toBe(404);
    for (const nodes of [
      [node({ translationId: "starter-home-en" })],
      [
        node({
          kind: "link",
          translationId: null,
          label: "Unsafe",
          externalUrl: "javascript:alert(1)",
        }),
      ],
      [
        node({
          id: "loop",
          parentId: "loop",
          kind: "group",
          label: "Cycle",
          translationId: null,
        }),
      ],
      [node(), node({ id: "duplicate-target", position: 1 })],
    ])
      expect(
        (await request("/zh", "PUT", input(initial.version, nodes))).status,
      ).toBe(400);
    expect(await get()).toMatchObject(persisted(initial));
  });

  it("accepts a valid tree larger than the auth body limit and bounds the streamed navigation body", async () => {
    const initial = await get();
    const nodes = Array.from({ length: 40 }, (_, index) =>
      node({
        id: `external-${index}`,
        kind: "link",
        position: index,
        label: `Link ${index}`,
        translationId: null,
        externalUrl: `https://example.com/${"a".repeat(100)}/${index}`,
      }),
    );
    const payload = input(initial.version, nodes);
    expect(
      new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    ).toBeGreaterThan(4096);
    const savedResponse = await request("/zh", "PUT", payload);
    expect(savedResponse.status).toBe(200);
    const saved = await get();
    const oversized = new TextEncoder().encode(
      JSON.stringify({
        ...input(saved.version),
        padding: "x".repeat(500 * 1024),
      }),
    );
    const response = await adminApi(
      new Request(`${origin}/api/admin/navigation/zh`, {
        method: "PUT",
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(oversized.subarray(0, 250 * 1024));
            controller.enqueue(oversized.subarray(250 * 1024));
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
    const announced = await request("/zh", "PUT", input(saved.version), {
      ...headers,
      "Content-Length": String(500 * 1024 + 1),
    });
    expect(announced.status).toBe(400);
    expect(await announced.json()).toEqual({
      error: "The request is too large.",
    });
    expect(await get()).toMatchObject(persisted(saved));
  });

  it("rejects malformed JSON, invalid UTF-8, alternate methods, languages and queries", async () => {
    for (const payload of [
      new Uint8Array([0xc3, 0x28]),
      new TextEncoder().encode("[]"),
      new TextEncoder().encode("null"),
      new TextEncoder().encode("{"),
    ]) {
      const response = await adminApi(
        new Request(`${origin}/api/admin/navigation/zh`, {
          method: "PUT",
          headers,
          body: payload,
        }),
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await request("/zh", "PUT", input(1), {
          ...headers,
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(400);
    for (const path of [
      "/fr",
      "/%7Ah",
      "/zh?language=en",
      "/zh?version=1&version=2",
    ])
      expect((await request(path)).status).toBe(400);
    for (const path of ["", "/zh/", "/zh/extra"])
      expect((await request(path)).status).toBe(404);
    for (const method of ["POST", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await request("/zh", method);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, PUT");
    }
  });

  it("returns a generic storage failure without exposing SQL or private data", async () => {
    const broken = {
      ...env,
      DB: new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (/navigation_/.test(sql))
                throw new Error("SQL private navigation credential canary");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    const response = await adminApi(
      new Request(`${origin}/api/admin/navigation/zh`, { headers }),
      broken,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Administration temporarily unavailable",
    });
  });
});
