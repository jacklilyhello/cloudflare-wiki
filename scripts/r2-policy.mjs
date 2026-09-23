import { WORKER_NAME } from "./deploy-policy.mjs";

export const R2_BUCKET = "cloudflare-wiki-assets-test";
export const R2_BINDING = "MEDIA";
export const R2_OWNER_KEY = "__cloudflare_wiki_owner_v1.json";
export const R2_OWNER = Object.freeze({
  schema: 1,
  app_id: "jacklilyhello/cloudflare-wiki",
  environment: "test",
  bucket: R2_BUCKET,
});

export class R2Error extends Error {}
export function r2Fail(message) {
  throw new R2Error(message);
}
export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function defaultJurisdiction(value) {
  return value === undefined || value === "default";
}

export function validateR2Config(config) {
  const bindings = config?.r2_buckets;
  const binding = bindings?.[0];
  if (
    config?.name !== WORKER_NAME ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    !isObject(binding) ||
    binding.binding !== R2_BINDING ||
    binding.bucket_name !== R2_BUCKET ||
    binding.remote !== false ||
    !defaultJurisdiction(binding.jurisdiction) ||
    Object.keys(binding).some(
      (key) =>
        !["binding", "bucket_name", "remote", "jurisdiction"].includes(key),
    )
  )
    r2Fail("Deployment requires the fixed local-only MEDIA bucket binding.");
}

function workerBindings(settings) {
  if (
    !isObject(settings) ||
    !Array.isArray(settings.bindings) ||
    settings.bindings.some((binding) => !isObject(binding))
  )
    r2Fail("Worker settings are malformed.");
  return settings.bindings;
}
export function verifyWorkerOwnership(settings) {
  const owners = workerBindings(settings).filter(
    (binding) => binding.name === "APP_ID",
  );
  if (
    owners.length !== 1 ||
    owners[0].type !== "plain_text" ||
    owners[0].text !== R2_OWNER.app_id
  )
    r2Fail("Worker ownership is not verified.");
}

// Returns whether MEDIA exists; allowAbsent never permits a conflicting binding.
export function verifyWorkerR2Binding(settings, { allowAbsent = false } = {}) {
  if (settings == null && allowAbsent) return false;
  const bindings = workerBindings(settings).filter(
    (binding) => binding.name === R2_BINDING || binding.type === "r2_bucket",
  );
  if (allowAbsent && !bindings.length) return false;
  const binding = bindings[0];
  if (
    bindings.length !== 1 ||
    binding?.name !== R2_BINDING ||
    binding.type !== "r2_bucket" ||
    binding.bucket_name !== R2_BUCKET ||
    !defaultJurisdiction(binding.jurisdiction)
  )
    r2Fail("Worker MEDIA binding conflicts with the target bucket.");
  return true;
}

export function validateR2Marker(marker) {
  if (
    !isObject(marker) ||
    Object.keys(marker).length !== Object.keys(R2_OWNER).length ||
    Object.entries(R2_OWNER).some(
      ([key, value]) => !Object.hasOwn(marker, key) || marker[key] !== value,
    )
  )
    r2Fail("Existing bucket ownership is not verified.");
}

export function validateR2StorageClass(bucket) {
  if (bucket.storage_class !== undefined && bucket.storage_class !== "Standard")
    r2Fail("The target bucket storage class is not Standard.");
}
