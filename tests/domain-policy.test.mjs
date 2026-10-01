import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_DOMAINS } from "../scripts/deploy-policy.mjs";
import {
  validateDomainPreflight,
  validateDomains,
} from "../scripts/domain-policy.mjs";

const zoneId = "c".repeat(32);
const domain = (hostname) => ({
  hostname,
  zone_id: zoneId,
  service: "cloudflare-wiki",
  environment: "production",
  enabled: true,
  previews_enabled: false,
});
const input = {
  zoneId,
  domains: [domain("cf.emby.wiki")],
  routes: [],
  records: {
    "emby.wiki": [
      { name: "emby.wiki", type: "TXT" },
      { name: "emby.wiki", type: "CAA" },
    ],
    "www.emby.wiki": [],
    "cf.emby.wiki": [{ name: "cf.emby.wiki", type: "AAAA" }],
  },
};
test("allows the retained domain and apex verification records without replacing DNS", () => {
  validateDomainPreflight(input);
  validateDomainPreflight({ ...input, domains: PUBLIC_DOMAINS.map(domain) });
  validateDomains(PUBLIC_DOMAINS.map(domain), zoneId, true);
});
for (const type of ["A", "AAAA", "CNAME", "NS"]) {
  test(`stops on conflicting ${type} records on an unbound production hostname`, () => {
    assert.throws(
      () =>
        validateDomainPreflight({
          ...input,
          records: {
            ...input.records,
            "emby.wiki": [{ name: "emby.wiki", type }],
          },
        }),
      /conflicting DNS/,
    );
  });
}
for (const pattern of [
  "emby.wiki/*",
  "https://www.emby.wiki/admin*",
  "*.emby.wiki/*",
  "*emby.wiki/*",
  "*/*",
]) {
  test(`stops on an overlapping Worker route ${pattern}`, () => {
    assert.throws(
      () =>
        validateDomainPreflight({
          ...input,
          routes: [{ pattern, script: "other-worker" }],
        }),
      /route conflicts/,
    );
  });
}
test("unrelated routes and Worker domains remain untouched", () => {
  validateDomainPreflight({
    ...input,
    domains: [
      ...input.domains,
      { ...domain("other.example"), service: "other-worker" },
    ],
    routes: [{ pattern: "unrelated.emby.wiki/*", script: "other-worker" }],
  });
});
for (const domains of [
  [{ ...domain("emby.wiki"), service: "other-worker" }],
  [{ ...domain("emby.wiki"), zone_id: "wrong" }],
  [domain("unexpected.example")],
  [domain("cf.emby.wiki"), domain("cf.emby.wiki")],
]) {
  test("rejects conflicting, extra or duplicate Custom Domains", () => {
    assert.throws(() => validateDomains(domains, zoneId));
  });
}
for (const change of [
  { enabled: false },
  { previews_enabled: true },
  { environment: "test" },
]) {
  test(`readback requires active production domains: ${Object.keys(change)[0]}`, () => {
    assert.throws(() =>
      validateDomains(
        PUBLIC_DOMAINS.map((hostname) => ({ ...domain(hostname), ...change })),
        zoneId,
        true,
      ),
    );
  });
}
test("readback must include all three domains", () => {
  assert.throws(() => validateDomains(input.domains, zoneId, true));
});
