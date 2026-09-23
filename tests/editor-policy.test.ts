import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  normalizeAdminReturnTo,
  parseAdminRoute,
} from "../shared/admin-routes";
import { editorPolicy } from "../worker/editor-policy";
import { securityHeaders } from "../worker/security";
import { fixtureSessionToken, seedContentAccess } from "./content-fixture";

beforeEach(async () => {
  await seedContentAccess(env.DB);
});

describe("safe administrator login return paths", () => {
  it.each([
    ["/admin/pages/new", "/admin/pages/new"],
    ["/admin/pages/new/?language=zh", "/admin/pages/new?language=zh"],
    [
      "/admin/pages/new?pageId=seed%3Ahome&language=en",
      "/admin/pages/new?language=en&pageId=seed%3Ahome",
    ],
    ["/admin/pages/new?pageId=page_1", "/admin/pages/new?pageId=page_1"],
    ["/admin/pages/seed:zh:home/edit/", "/admin/pages/seed%3Azh%3Ahome/edit"],
    [
      "/admin/pages/seed%3Aen%3Ahome/history",
      "/admin/pages/seed%3Aen%3Ahome/history",
    ],
  ])("normalizes only the intended document %s", (input, expected) => {
    expect(normalizeAdminReturnTo(input)).toBe(expected);
  });

  it.each([
    "/admin/pages/new?language=fr",
    "/admin/pages/new?language=EN",
    "/admin/pages/new?language=",
    "/admin/pages/new?pageId=",
    "/admin/pages/new?pageId=-invalid",
    "/admin/pages/new?pageId=one%2Ftwo",
    "/admin/pages/new?pageId=one%5Ctwo",
    "/admin/pages/new?pageId=%00",
    "/admin/pages/new?pageId=%",
    `/admin/pages/new?pageId=${"a".repeat(129)}`,
    "/admin/pages/new?language=en&language=zh",
    "/admin/pages/new?language=en&%6canguage=en",
    "/admin/pages/new?pageId=a&pageId=a",
    "/admin/pages/new?next=https%3A%2F%2Fattacker.invalid",
    "/admin/pages/new?language=en&unrecognized=1",
    "/admin/pages/id/edit?language=en",
    "/admin/pages/id/history?pageId=a",
    "/admin/pages/new#fragment",
    "/admin/pages/a%2Fb/edit",
    "/admin/pages/new/../new",
    "/admin/pages/%2e%2e/pages/new",
    "/admin/pages/new\\@attacker.invalid",
    "/admin/pages/new\n?language=en",
    "/admin",
    "/admin/account",
    "/admin/pages",
    "//attacker.invalid/admin/pages/new",
    "https://attacker.invalid/admin/pages/new",
    "https://wiki.invalid/admin/pages/new",
    "javascript:alert(1)",
    null,
  ])(
    "rejects ambiguous, unrecognized or external return target %s",
    (input) => {
      expect(normalizeAdminReturnTo(input)).toBeNull();
    },
  );

  it("preserves an anonymous translation creation target through the login redirect", async () => {
    const target = "/admin/pages/new?language=en&pageId=seed%3Ahome";
    const response = await exports.default.fetch(
      `https://example.com${target}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(303);
    const loginUrl = new URL(
      response.headers.get("Location") ?? "",
      "https://example.com",
    );
    expect(loginUrl.pathname).toBe("/admin");
    expect(normalizeAdminReturnTo(loginUrl.searchParams.get("returnTo"))).toBe(
      target,
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(
      securityHeaders["Content-Security-Policy"],
    );
    for (const query of [
      "language=en&language=zh",
      "pageId=bad%2Fidentity",
      "redirect=https%3A%2F%2Fattacker.invalid",
    ]) {
      const invalid = await exports.default.fetch(
        `https://example.com/admin/pages/new?${query}`,
        { redirect: "manual" },
      );
      expect(invalid.status).toBe(303);
      expect(invalid.headers.get("Location")).toBe("/admin");
    }
  });
});

describe("editor document security policy", () => {
  it("shares exact routing with the UI and rejects malformed or encoded separators", () => {
    expect(parseAdminRoute("/admin/files")).toEqual({ page: "files" });
    expect(parseAdminRoute("/admin/pages/seed%3Azh%3Ahome/edit")).toEqual({
      page: "editor",
      translationId: "seed:zh:home",
    });
    for (const path of [
      "/admin/pages/a%2Fb/edit",
      "/admin/pages/%/edit",
      "/admin/pages/a%22/edit",
      "/admin/pages/a/edit/extra",
    ])
      expect(parseAdminRoute(path)).toEqual({ page: "not-found" });
  });

  it("uses fresh style nonces only for editor documents and keeps script execution strict", () => {
    for (const path of [
      "/admin/pages/new",
      "/admin/pages/id/edit",
      "/admin/pages/id/history",
    ])
      expect(editorPolicy(path)?.csp).toContain("worker-src 'self'");
    const first = editorPolicy("/admin/pages/new");
    const second = editorPolicy("/admin/pages/new");
    expect(first?.nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(first?.nonce).not.toBe(second?.nonce);
    expect(first?.csp).toContain("script-src 'self';");
    expect(first?.csp).toContain("frame-ancestors 'none'");
    expect(first?.csp).not.toContain("unsafe-eval");
    expect(first?.csp).toContain(`style-src 'self' 'nonce-${first?.nonce}'`);
    for (const path of [
      "/zh/home",
      "/admin",
      "/admin/account",
      "/admin/pages",
      "/admin/files",
      "/admin/pages/id%2Fother/edit",
    ])
      expect(editorPolicy(path)).toBeNull();
  });

  it("pairs the response header with its inert nonce meta and leaves ordinary pages unchanged", async () => {
    const response = await exports.default.fetch(
      "https://example.com/admin/pages/new",
      { headers: { Cookie: `__Host-wiki_session=${fixtureSessionToken}` } },
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    const nonce =
      /<meta property="csp-nonce" nonce="([A-Za-z0-9+/]{24})">/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(response.headers.get("Content-Security-Policy")).toContain(
      `'nonce-${nonce}'`,
    );
    const login = await exports.default.fetch("https://example.com/admin");
    expect(login.headers.get("Content-Security-Policy")).toBe(
      securityHeaders["Content-Security-Policy"],
    );
    expect(await login.text()).not.toContain('property="csp-nonce"');
    const files = await exports.default.fetch(
      "https://example.com/admin/files",
    );
    expect(files.status).toBe(200);
    expect(files.headers.get("Content-Security-Policy")).toBe(
      securityHeaders["Content-Security-Policy"],
    );
    expect(await files.text()).not.toContain('property="csp-nonce"');
    expect(
      (await exports.default.fetch("https://example.com/admin/unknown")).status,
    ).toBe(404);
    const anonymous = await exports.default.fetch(
      "https://example.com/admin/pages/new",
      { redirect: "manual" },
    );
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("Location")).toBe(
      "/admin?returnTo=%2Fadmin%2Fpages%2Fnew",
    );
    expect(anonymous.headers.get("Content-Security-Policy")).toBe(
      securityHeaders["Content-Security-Policy"],
    );
  });
});
