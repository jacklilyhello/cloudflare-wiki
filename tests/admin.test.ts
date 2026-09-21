import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../shared/auth";
import { adminApi } from "../worker/admin";
import { sha256 } from "../worker/auth/crypto";
import { ContentService } from "../worker/content/service";

const origin = "https://example.com";
// Local fixtures only; these values are never deployed as credentials.
const setupToken = "test-only-bootstrap-abcdefghijklmnopqrstuvwxyz0123456789";
const password = "local-test-password-for-wiki-2026";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
});

async function request(path: string, options: RequestInit = {}) {
  return exports.default.fetch(`${origin}/api/admin${path}`, options);
}

function post(
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  };
}

async function provision() {
  await env.DB.prepare(
    "INSERT INTO admin_bootstrap(id,token_hash,expires_at) VALUES(1,?,?)",
  )
    .bind(await sha256(setupToken), Date.now() + 60_000)
    .run();
}

async function initialize() {
  await provision();
  const response = await request(
    "/setup",
    post({ token: setupToken, username: "owner", password }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("Set-Cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const { session } = (await response.json()) as { session: AuthSession };
  return {
    cookie,
    setCookie,
    session,
    headers: {
      Cookie: cookie,
      "X-CSRF-Token": session.csrfToken,
      Origin: origin,
    },
  };
}

describe("administrator HTTP security boundary", () => {
  it("keeps every privileged route closed and only serves a credential-free admin shell", async () => {
    for (const path of [
      "/session",
      "/overview",
      "/pages",
      "/password",
      "/profile",
      "/logout",
    ])
      expect((await request(path)).status).toBe(401);
    expect(await (await request("/setup")).json()).toEqual({
      initialized: false,
      setupAvailable: false,
    });
    const page = await exports.default.fetch(`${origin}/admin`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).not.toContain(
      "unsafe-inline",
    );
    const html = await page.text();
    expect(html).toContain("Administration");
    expect(html).not.toContain("reader-data");
    expect(html).not.toContain("password_hash");
    expect(
      (await exports.default.fetch(`${origin}/admin`, { method: "POST" }))
        .status,
    ).toBe(405);
  });

  it("consumes bootstrap once and returns bearer credentials only through a secure HttpOnly cookie", async () => {
    const { cookie, setCookie, session } = await initialize();
    expect(setCookie).toMatch(/^__Host-wiki_session=[A-Za-z0-9_-]{43};/);
    for (const flag of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
      "Expires=",
    ])
      expect(setCookie).toContain(flag);
    expect(setCookie).not.toContain("Domain=");
    expect(JSON.stringify(session)).not.toContain(cookie.split("=")[1]);
    expect(session.user).toEqual({ id: 1, username: "owner", version: 1 });
    expect(await (await request("/setup")).json()).toEqual({
      initialized: true,
      setupAvailable: false,
    });
    const denied = await request(
      "/setup",
      post({ token: setupToken, username: "another-owner", password }),
    );
    expect(denied.status).toBe(403);
    const stored = await env.DB.prepare(
      "SELECT password_hash FROM administrators WHERE id=1",
    ).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^scrypt\$/);
    expect(stored?.password_hash).not.toContain(password);
    const status = await request("/session", { headers: { Cookie: cookie } });
    expect(status.headers.get("Cache-Control")).toBe("no-store");
    expect(status.headers.get("Vary")).toContain("Cookie");
    expect(await status.json()).toMatchObject({
      authenticated: true,
      session: { user: { username: "owner" } },
    });
  });

  it("rejects cross-site and CSRF-free writes without revoking the valid session", async () => {
    const auth = await initialize();
    for (const headers of [
      { Cookie: auth.cookie },
      { ...auth.headers, Origin: "https://attacker.invalid" },
      { ...auth.headers, "X-CSRF-Token": "wrong" },
      { ...auth.headers, "Sec-Fetch-Site": "cross-site" },
    ]) {
      const response = await request("/logout", { method: "POST", headers });
      expect(response.status).toBe(403);
      expect(
        (await request("/session", { headers: { Cookie: auth.cookie } }))
          .status,
      ).toBe(200);
    }
    expect(
      (await request("/logout", { method: "POST", headers: auth.headers }))
        .status,
    ).toBe(204);
    expect(
      (await request("/session", { headers: { Cookie: auth.cookie } })).status,
    ).toBe(401);
  });

  it("rejects malformed, oversized and non-JSON credential submissions before parsing them", async () => {
    const cases: RequestInit[] = [
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "text/plain" },
        body: "{}",
      },
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "[",
      },
      post([]),
      post({ username: "owner", password: "x".repeat(5000) }),
    ];
    for (const init of cases)
      expect((await request("/login", init)).status).toBe(400);
    expect(
      (
        await request(
          "/login",
          post({ username: "owner", password }, { Origin: "null" }),
        )
      ).status,
    ).toBe(403);
    expect((await request("/login", { method: "GET" })).status).toBe(405);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM admin_login_limits",
      ).first(),
    ).toEqual({ n: 0 });
  });

  it("never exposes dashboard draft metadata without a unique valid session cookie", async () => {
    const auth = await initialize();
    const service = new ContentService(env.DB);
    await service.createTranslation({
      language: "en",
      path: "private-overview-canary",
      title: "Private overview canary",
      description: "",
      markdown: "Private content",
      tags: [],
    });
    const authorized = await request("/overview", {
      headers: { Cookie: auth.cookie },
    });
    expect(authorized.status).toBe(200);
    const payload = (await authorized.json()) as {
      pages: { drafts: number };
      recent: Array<{ title: string }>;
    };
    expect(payload.pages.drafts).toBe(1);
    expect(
      payload.recent.some((item) => item.title === "Private overview canary"),
    ).toBe(true);
    for (const header of [
      "",
      `${auth.cookie}; ${auth.cookie}`,
      "__Host-wiki_session=invalid",
    ]) {
      const response = await request("/overview", {
        headers: { Cookie: header },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("canary");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("changes credentials only with current password and CSRF, then invalidates all sessions", async () => {
    const auth = await initialize();
    const login = await request(
      "/login",
      post({ username: "owner", password }),
    );
    expect(login.status).toBe(200);
    const secondCookie = login.headers.get("Set-Cookie")?.split(";")[0] ?? "";
    const newPassword = "a-new-local-test-password-2026";
    const changed = await request("/password", {
      ...post(
        { currentPassword: password, newPassword, expectedVersion: 1 },
        auth.headers,
      ),
      method: "PUT",
    });
    expect(changed.status).toBe(204);
    expect(changed.headers.get("Set-Cookie")).toContain("Max-Age=0");
    for (const cookie of [auth.cookie, secondCookie])
      expect(
        (await request("/session", { headers: { Cookie: cookie } })).status,
      ).toBe(401);
    expect(
      (await request("/login", post({ username: "owner", password }))).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/login",
          post({ username: "owner", password: newPassword }),
        )
      ).status,
    ).toBe(200);
  });

  it("does not expose database errors or credentials when authentication storage fails", async () => {
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error("private database and credential canary");
        },
      },
    } as unknown as Env;
    const response = await adminApi(
      new Request(`${origin}/api/admin/setup`),
      broken,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      JSON.stringify({ error: "Authentication is unavailable." }),
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
