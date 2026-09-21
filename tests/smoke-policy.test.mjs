import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_SMOKE_BASE_URL,
  validateSmokeBaseUrl,
  workersDevBaseUrl,
} from "../scripts/smoke-policy.mjs";
import { checkAdmin } from "../scripts/smoke-test.mjs";

const accountSubdomain = "account-subdomain";
const workersDevBase = workersDevBaseUrl(accountSubdomain);

test("allows localhost and the fixed test Custom Domain", () => {
  assert.equal(
    validateSmokeBaseUrl(LOCAL_SMOKE_BASE_URL).origin,
    LOCAL_SMOKE_BASE_URL,
  );
  assert.equal(
    validateSmokeBaseUrl("https://cf.emby.wiki").hostname,
    "cf.emby.wiki",
  );
});

test("allows only the exact Cloudflare-derived workers.dev smoke URL", () => {
  assert.equal(
    validateSmokeBaseUrl(workersDevBase, accountSubdomain).href,
    `${workersDevBase}/`,
  );
  assert.throws(() =>
    validateSmokeBaseUrl(
      "https://cloudflare-wiki.other-account.workers.dev",
      accountSubdomain,
    ),
  );
  assert.throws(() => validateSmokeBaseUrl(workersDevBase));
});

test("rejects arbitrary external, production, and malformed smoke targets", () => {
  for (const base of [
    "https://example.com",
    "https://emby.wiki",
    "https://cf.emby.wiki/",
    "https://cloudflare-wiki.account-subdomain.workers.dev/health",
  ]) {
    assert.throws(() => validateSmokeBaseUrl(base, accountSubdomain));
  }
});

test("rejects invalid Cloudflare Workers account subdomains", () => {
  for (const subdomain of [
    "",
    "-invalid",
    "invalid-",
    "with.dot",
    "UPPERCASE",
  ]) {
    assert.throws(() => workersDevBaseUrl(subdomain));
  }
});

const adminHeaders = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'",
};

const adminApiPaths = [
  "/api/admin/session",
  "/api/admin/overview",
  "/api/admin/pages",
  "/api/admin/pages/starter-home-en",
  "/api/admin/pages/starter-home-en/revisions",
  "/api/admin/pages/starter-home-en/events",
  "/api/admin/navigation/zh",
  "/api/admin/audit",
];
const editorPaths = [
  "/admin/pages/new",
  "/admin/pages/starter-home-en/history",
];

function adminResponses(
  status = { initialized: false, setupAvailable: false },
) {
  return new Map([
    [
      "/admin",
      new Response(
        '<title>Administration · Emby Wiki</title><div id="root"></div><script src="/assets/app.js"></script>',
        { headers: { ...adminHeaders, "Content-Type": "text/html" } },
      ),
    ],
    ...adminApiPaths.map((path) => [
      path,
      Response.json(
        { error: "Sign in required" },
        { status: 401, headers: adminHeaders },
      ),
    ]),
    ...editorPaths.map((path) => [
      path,
      new Response(null, {
        status: 303,
        headers: {
          ...adminHeaders,
          Location: `/admin?returnTo=${encodeURIComponent(path)}`,
        },
      }),
    ]),
    ["/api/admin/setup", Response.json(status, { headers: adminHeaders })],
  ]);
}

function getFixture(responses, calls = []) {
  return async (path, options) => {
    // The smoke helper cannot carry credentials or select a mutation method.
    assert.deepEqual(
      options,
      editorPaths.includes(path) ? { redirect: "manual" } : undefined,
    );
    calls.push(path);
    assert.ok(responses.has(path), `Unexpected smoke request: ${path}`);
    return responses.get(path);
  };
}

test("admin smoke accepts all lifecycle states using only anonymous reads", async () => {
  for (const status of [
    { initialized: false, setupAvailable: false },
    { initialized: false, setupAvailable: true },
    { initialized: true, setupAvailable: false },
  ]) {
    const calls = [];
    await checkAdmin(getFixture(adminResponses(status), calls));
    assert.deepEqual(calls, [
      "/admin",
      "/api/admin/session",
      "/api/admin/overview",
      "/api/admin/pages",
      "/api/admin/pages/starter-home-en",
      "/api/admin/pages/starter-home-en/revisions",
      "/api/admin/pages/starter-home-en/events",
      "/api/admin/navigation/zh",
      "/api/admin/audit",
      "/admin/pages/new",
      "/admin/pages/starter-home-en/history",
      "/api/admin/setup",
    ]);
  }
});

test("admin smoke rejects an anonymous API success or leaked response fields", async () => {
  for (const path of adminApiPaths) {
    for (const response of [
      Response.json({ error: "Sign in required" }, { headers: adminHeaders }),
      Response.json(
        { error: "Sign in required", pages: [] },
        { status: 401, headers: adminHeaders },
      ),
    ]) {
      const responses = adminResponses();
      responses.set(path, response);
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
});

test("admin smoke rejects malformed or credential-bearing setup status", async () => {
  for (const status of [
    null,
    { initialized: "false", setupAvailable: false },
    { initialized: false },
    { initialized: true, setupAvailable: true },
    { initialized: false, setupAvailable: true, token: "fixture-only" },
  ]) {
    await assert.rejects(checkAdmin(getFixture(adminResponses(status))));
  }
  const responses = adminResponses();
  responses
    .get("/api/admin/setup")
    .headers.set("Set-Cookie", "unexpected=fixture-only");
  await assert.rejects(checkAdmin(getFixture(responses)));
});

test("admin smoke rejects reader fallback and missing security headers", async () => {
  const fallback = adminResponses();
  fallback.set(
    "/admin",
    new Response("<article>Emby Wiki</article>", {
      headers: { ...adminHeaders, "Content-Type": "text/html" },
    }),
  );
  await assert.rejects(checkAdmin(getFixture(fallback)));
  for (const path of [
    "/admin",
    ...adminApiPaths,
    ...editorPaths,
    "/api/admin/setup",
  ]) {
    for (const header of [
      "Cache-Control",
      "X-Robots-Tag",
      "Content-Security-Policy",
    ]) {
      const responses = adminResponses();
      responses.get(path).headers.delete(header);
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
});

test("admin smoke rejects editor data, session issuance, unsafe redirects, and relaxed anonymous CSP", async () => {
  for (const path of editorPaths) {
    const redirect = `/admin?returnTo=${encodeURIComponent(path)}`;
    for (const response of [
      new Response("editor source", { headers: adminHeaders }),
      new Response("private document", {
        status: 303,
        headers: { ...adminHeaders, Location: redirect },
      }),
      new Response(null, {
        status: 303,
        headers: { ...adminHeaders, Location: "https://attacker.invalid" },
      }),
      new Response(null, {
        status: 303,
        headers: {
          ...adminHeaders,
          Location: redirect,
          "Set-Cookie": "unexpected=fixture-only",
        },
      }),
    ]) {
      const responses = adminResponses();
      responses.set(path, response);
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
  for (const path of [
    "/admin",
    ...adminApiPaths,
    ...editorPaths,
    "/api/admin/setup",
  ]) {
    for (const directive of [
      "style-src-attr 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-eval'",
    ]) {
      const responses = adminResponses();
      responses
        .get(path)
        .headers.set(
          "Content-Security-Policy",
          `${adminHeaders["Content-Security-Policy"]}; ${directive}`,
        );
      await assert.rejects(checkAdmin(getFixture(responses)));
    }
  }
});
