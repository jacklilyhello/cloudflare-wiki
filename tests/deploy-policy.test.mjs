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
  PUBLIC_DOMAINS,
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
  PRODUCTION_DOMAIN: "emby.wiki",
};
test("allows only main push or manual main deployment", () => {
  assert.doesNotThrow(() => validateDeployment(valid));
  assert.doesNotThrow(() =>
    validateDeployment({ ...valid, GITHUB_EVENT_NAME: "workflow_dispatch" }),
  );
});
test("disables workers.dev and Preview URLs while retaining existing storage in production", async () => {
  const sourceConfig = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.equal(sourceConfig.workers_dev, false);
  assert.equal(sourceConfig.preview_urls, false);
  assert.equal(sourceConfig.vars.APP_ENV, "production");
  assert.equal(sourceConfig.vars.PUBLIC_ORIGIN, "https://emby.wiki");
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
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(
    config.routes,
    PUBLIC_DOMAINS.map((pattern) => ({
      pattern,
      custom_domain: true,
      zone_id: valid.CLOUDFLARE_ZONE_ID,
    })),
  );
  assert.equal(config.vars.APP_ENV, "production");
  assert.equal(config.vars.PUBLIC_ORIGIN, "https://emby.wiki");
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
  PRODUCTION_DOMAIN: "unapproved.example",
  CLOUDFLARE_WORKER_NAME: "other-worker",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID: "invalid",
  GITHUB_SHA: "local",
})) {
  test(`rejects an unsafe or incomplete deployment: ${key}`, () => {
    assert.throws(() => validateDeployment({ ...valid, [key]: value }));
  });
}
