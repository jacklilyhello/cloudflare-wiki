import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDeployment } from "../scripts/deploy-policy.mjs";

const valid = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: "a".repeat(40),
  CLOUDFLARE_API_TOKEN: "test-only-placeholder",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
  CLOUDFLARE_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
  TEST_DOMAIN: "cf.emby.wiki",
};
test("allows only main push or manual main deployment", () => {
  assert.doesNotThrow(() => validateDeployment(valid));
  assert.doesNotThrow(() =>
    validateDeployment({ ...valid, GITHUB_EVENT_NAME: "workflow_dispatch" }),
  );
});
for (const [key, value] of Object.entries({
  GITHUB_ACTIONS: "false",
  GITHUB_REPOSITORY: "other/repo",
  GITHUB_REF: "refs/heads/feature/test",
  GITHUB_EVENT_NAME: "pull_request",
  TEST_DOMAIN: "emby.wiki",
  CLOUDFLARE_WORKER_NAME: "other-worker",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "invalid",
  GITHUB_SHA: "local",
})) {
  test(`rejects an unsafe or incomplete deployment: ${key}`, () => {
    assert.throws(() => validateDeployment({ ...valid, [key]: value }));
  });
}
