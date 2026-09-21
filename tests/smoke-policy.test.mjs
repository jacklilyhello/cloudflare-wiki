import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_SMOKE_BASE_URL,
  validateSmokeBaseUrl,
  workersDevBaseUrl,
} from "../scripts/smoke-policy.mjs";

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
