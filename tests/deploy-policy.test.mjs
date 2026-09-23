import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  D1_BINDING,
  D1_NAME,
  LOCAL_D1_ID,
  validateD1Config,
} from "../scripts/d1-policy.mjs";
import {
  buildDeploymentConfig,
  TEST_DOMAIN,
  validateDeployment,
  WORKER_NAME,
} from "../scripts/deploy-policy.mjs";
import { R2_BUCKET } from "../scripts/r2-readiness.mjs";
import { validateR2Config } from "../scripts/r2-provision.mjs";

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
test("keeps workers.dev enabled and Preview URLs disabled in source and deployment config", async () => {
  const sourceConfig = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.equal(sourceConfig.workers_dev, true);
  assert.equal(sourceConfig.preview_urls, false);
  assert.doesNotThrow(() => validateD1Config(sourceConfig));
  assert.doesNotThrow(() => validateR2Config(sourceConfig));
  assert.deepEqual(sourceConfig.r2_buckets, [
    { binding: "MEDIA", bucket_name: R2_BUCKET, remote: false },
  ]);
  assert.deepEqual(sourceConfig.d1_databases, [
    {
      binding: D1_BINDING,
      database_name: D1_NAME,
      database_id: LOCAL_D1_ID,
      migrations_dir: "migrations",
      remote: false,
    },
  ]);

  const config = buildDeploymentConfig(
    {
      name: WORKER_NAME,
      workers_dev: false,
      preview_urls: true,
      vars: { APP_ENV: "test" },
      r2_buckets: sourceConfig.r2_buckets,
    },
    valid,
  );
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [
    {
      pattern: TEST_DOMAIN,
      custom_domain: true,
      zone_id: valid.CLOUDFLARE_ZONE_ID,
    },
  ]);
  assert.equal(config.vars.BUILD_SHA, valid.GITHUB_SHA);
  assert.doesNotThrow(() => validateR2Config(config));
  assert.deepEqual(config.r2_buckets, sourceConfig.r2_buckets);
});
test("rejects an unexpected built Worker before deployment", () => {
  assert.throws(() =>
    buildDeploymentConfig({ name: "other-worker", vars: {} }, valid),
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
