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
  "Content-Security-Policy": "default-src 'self'; script-src 'self'",
};

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
    ...["/api/admin/session", "/api/admin/overview"].map((path) => [
      path,
      Response.json(
        { error: "Sign in required" },
        { status: 401, headers: adminHeaders },
      ),
    ]),
    ["/api/admin/setup", Response.json(status, { headers: adminHeaders })],
  ]);
}

function getFixture(responses, calls = []) {
  return async (path, options) => {
    // The smoke helper cannot carry credentials or select a mutation method.
    assert.equal(options, undefined);
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
      "/api/admin/setup",
    ]);
  }
});

test("admin smoke rejects an anonymous API success or leaked response fields", async () => {
  for (const path of ["/api/admin/session", "/api/admin/overview"]) {
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
    "/api/admin/session",
    "/api/admin/overview",
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
