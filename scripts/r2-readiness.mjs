import { pathToFileURL } from "node:url";
import { validateDeployment, WORKER_NAME } from "./deploy-policy.mjs";

export const R2_BUCKET = "cloudflare-wiki-assets-test";
export const R2_OWNER_KEY = "__cloudflare_wiki_owner_v1.json";
export const R2_OWNER = Object.freeze({
  schema: 1,
  app_id: "jacklilyhello/cloudflare-wiki",
  environment: "test",
  bucket: R2_BUCKET,
});
const pageSize = 100;
const pageLimit = 25;
const responseLimit = 256 * 1024;

class ReadinessError extends Error {}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message) {
  throw new ReadinessError(`R2 readiness: ${message} No changes were made.`);
}
async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Never expose transport errors or upstream response bodies.
  }
}
async function boundedJson(response, maximum, operation) {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximum)
  ) {
    await discard(response);
    fail(`${operation} response exceeds its limit.`);
  }
  if (!response.body) fail(`${operation} returned an invalid response.`);
  const reader = response.body.getReader();
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${operation} returned an invalid or oversized response.`);
  } finally {
    reader.releaseLock();
  }
}
function defaultJurisdiction(value) {
  return value === undefined || value === "default";
}
function verifyWorker(settings, bucketExists) {
  if (
    !object(settings) ||
    !Array.isArray(settings.bindings) ||
    settings.bindings.some((binding) => !object(binding))
  )
    fail("Worker settings are malformed.");
  const owners = settings.bindings.filter(
    (binding) => binding.name === "APP_ID",
  );
  if (
    owners.length !== 1 ||
    owners[0].type !== "plain_text" ||
    owners[0].text !== R2_OWNER.app_id
  )
    fail("Worker ownership is not verified.");
  const bindings = settings.bindings.filter(
    (binding) => binding.name === "MEDIA" || binding.type === "r2_bucket",
  );
  if (!bindings.length) return;
  if (
    !bucketExists ||
    bindings.length !== 1 ||
    bindings[0].name !== "MEDIA" ||
    bindings[0].type !== "r2_bucket" ||
    bindings[0].bucket_name !== R2_BUCKET ||
    !defaultJurisdiction(bindings[0].jurisdiction)
  )
    fail("Worker MEDIA binding conflicts with the target bucket.");
}

// A read-only observation with an injected transport. No provisioning, billing,
// token introspection, configuration writes, subprocesses or retries exist here.
export async function checkR2Readiness(env, { fetch: fetchRequest }) {
  try {
    validateDeployment(env);
  } catch {
    fail("Actions deployment configuration is unauthorized or incomplete.");
  }
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
    fail("Only an explicit manual main Actions run may inspect readiness.");
  const account = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const bucketPath = `${account}/r2/buckets/${R2_BUCKET}`;
  async function get(path, operation, marker = false) {
    let response;
    try {
      response = await fetchRequest(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            ...(path.startsWith(`${account}/r2/`)
              ? { "cf-r2-jurisdiction": "default" }
              : {}),
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      fail(`${operation} request failed; no retry was attempted.`);
    }
    if (!(response instanceof Response))
      fail(`${operation} returned an invalid response.`);
    if (response.status !== 200 || response.redirected) {
      await discard(response);
      fail(`${operation} request failed (HTTP ${response.status}).`);
    }
    const body = await boundedJson(
      response,
      marker ? 1024 : responseLimit,
      operation,
    );
    if (marker) return body;
    if (
      !object(body) ||
      body.success !== true ||
      (body.errors !== undefined &&
        (!Array.isArray(body.errors) || body.errors.length !== 0))
    )
      fail(`${operation} returned an unsuccessful API envelope.`);
    return body;
  }

  let cursor;
  let target;
  let complete = false;
  const cursors = new Set();
  const names = new Set();
  for (let page = 0; page < pageLimit; page++) {
    const query = new URLSearchParams({
      name_contains: R2_BUCKET,
      per_page: String(pageSize),
    });
    if (cursor) query.set("cursor", cursor);
    // Keep the complete envelope: R2's next cursor is outside result.buckets.
    const body = await get(`${account}/r2/buckets?${query}`, "Inventory");
    const buckets = body.result?.buckets;
    const info = body.result_info;
    if (
      !object(body.result) ||
      !Array.isArray(buckets) ||
      buckets.length > pageSize ||
      (info !== undefined && !object(info))
    )
      fail("Inventory or pagination is malformed.");
    if (info?.per_page !== undefined && info.per_page !== pageSize)
      fail("Inventory pagination limit is inconsistent.");
    for (const bucket of buckets) {
      if (
        !object(bucket) ||
        typeof bucket.name !== "string" ||
        bucket.name.length < 3 ||
        bucket.name.length > 64 ||
        names.has(bucket.name)
      )
        fail("Inventory contains malformed or duplicate buckets.");
      names.add(bucket.name);
      if (bucket.name === R2_BUCKET) {
        if (!defaultJurisdiction(bucket.jurisdiction))
          fail("Target bucket is outside the default jurisdiction.");
        target = bucket;
      }
    }
    const next = info?.cursor;
    if (next !== undefined && (typeof next !== "string" || next.length > 4096))
      fail("Inventory pagination is malformed.");
    if (!next) {
      // A full page without continuation metadata is not proof of completeness.
      if (buckets.length === pageSize)
        fail("Inventory pagination is incomplete.");
      complete = true;
      break;
    }
    if (cursors.has(next)) fail("Inventory pagination repeated a cursor.");
    cursors.add(next);
    cursor = next;
  }
  if (!complete) fail("Inventory exceeded the pagination limit.");
  const worker = await get(
    `${account}/workers/scripts/${WORKER_NAME}/settings`,
    "Worker settings",
  );
  verifyWorker(worker.result, Boolean(target));
  if (!target)
    return "R2 inventory readable; target bucket absent; write permission unverified";

  const marker = await get(
    `${bucketPath}/objects/${R2_OWNER_KEY}`,
    "Ownership marker",
    true,
  );
  if (
    !object(marker) ||
    Object.keys(marker).length !== Object.keys(R2_OWNER).length ||
    Object.entries(R2_OWNER).some(
      ([key, value]) => !Object.hasOwn(marker, key) || marker[key] !== value,
    )
  )
    fail("Existing bucket ownership is not verified.");
  const managed = await get(`${bucketPath}/domains/managed`, "Managed domain");
  if (!object(managed.result) || managed.result.enabled !== false)
    fail("The target bucket is public or its managed-domain state is unknown.");
  const custom = await get(`${bucketPath}/domains/custom`, "Custom domains");
  if (
    !object(custom.result) ||
    !Array.isArray(custom.result.domains) ||
    custom.result.domains.length !== 0
  )
    fail("The target bucket has custom domains or their state is unknown.");
  return "R2 inventory readable; target bucket ownership and private access verified; write permission unverified";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(await checkR2Readiness(process.env, { fetch }));
  } catch (error) {
    console.error(
      error instanceof ReadinessError
        ? error.message
        : "R2 readiness: Verification failed. No changes were made.",
    );
    process.exitCode = 1;
  }
}
