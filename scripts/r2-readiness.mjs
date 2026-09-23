import { pathToFileURL } from "node:url";
import { validateDeployment, WORKER_NAME } from "./deploy-policy.mjs";
import {
  defaultJurisdiction,
  isObject,
  R2_BUCKET,
  R2_OWNER_KEY,
  R2Error,
  r2Fail,
  validateR2Marker,
  verifyWorkerOwnership,
  verifyWorkerR2Binding,
} from "./r2-policy.mjs";

export { R2_BUCKET, R2_OWNER, R2_OWNER_KEY } from "./r2-policy.mjs";

const pageSize = 100;
const pageLimit = 25;
const responseLimit = 256 * 1024;
class ReadinessError extends Error {}

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
    r2Fail(`${operation} response exceeds its limit.`);
  }
  if (!response.body) r2Fail(`${operation} returned an invalid response.`);
  let reader;
  try {
    reader = response.body.getReader();
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
    r2Fail(`${operation} returned an invalid or oversized response.`);
  } finally {
    reader?.releaseLock();
  }
}

// Pure response parsing is shared with provisioning; it never issues a request.
export async function readR2Response(response, operation, marker = false) {
  if (!(response instanceof Response))
    r2Fail(`${operation} returned an invalid response.`);
  if (response.status !== 200 || response.redirected) {
    await discard(response);
    r2Fail(`${operation} request failed (HTTP ${response.status}).`);
  }
  const body = await boundedJson(
    response,
    marker ? 1024 : responseLimit,
    operation,
  );
  if (marker) return body;
  if (
    !isObject(body) ||
    body.success !== true ||
    (body.errors !== undefined &&
      (!Array.isArray(body.errors) || body.errors.length !== 0))
  )
    r2Fail(`${operation} returned an unsuccessful API envelope.`);
  return body;
}

// This transport only issues GETs. The readiness entry point never imports or
// invokes the provisioner, including when called from a main push.
export function createR2Reader(env, fetchRequest) {
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
      r2Fail(`${operation} request failed; no retry was attempted.`);
    }
    return readR2Response(response, operation, marker);
  }
  return { account, bucketPath, get };
}

export async function inspectR2Inventory({ account, get }) {
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
      !isObject(body.result) ||
      !Array.isArray(buckets) ||
      buckets.length > pageSize ||
      (info !== undefined && !isObject(info))
    )
      r2Fail("Inventory or pagination is malformed.");
    if (info?.per_page !== undefined && info.per_page !== pageSize)
      r2Fail("Inventory pagination limit is inconsistent.");
    for (const bucket of buckets) {
      if (
        !isObject(bucket) ||
        typeof bucket.name !== "string" ||
        bucket.name.length < 3 ||
        bucket.name.length > 64 ||
        names.has(bucket.name)
      )
        r2Fail("Inventory contains malformed or duplicate buckets.");
      names.add(bucket.name);
      if (bucket.name === R2_BUCKET) {
        if (!defaultJurisdiction(bucket.jurisdiction))
          r2Fail("Target bucket is outside the default jurisdiction.");
        target = bucket;
      }
    }
    const next = info?.cursor;
    if (next !== undefined && (typeof next !== "string" || next.length > 4096))
      r2Fail("Inventory pagination is malformed.");
    if (!next) {
      // A full page without continuation metadata is not proof of completeness.
      if (buckets.length === pageSize)
        r2Fail("Inventory pagination is incomplete.");
      complete = true;
      break;
    }
    if (cursors.has(next)) r2Fail("Inventory pagination repeated a cursor.");
    cursors.add(next);
    cursor = next;
  }
  if (!complete) r2Fail("Inventory exceeded the pagination limit.");
  return target;
}

export async function verifyR2OwnershipAndPrivacy({ bucketPath, get }) {
  const marker = await get(
    `${bucketPath}/objects/${R2_OWNER_KEY}`,
    "Ownership marker",
    true,
  );
  validateR2Marker(marker);
  const managed = await get(`${bucketPath}/domains/managed`, "Managed domain");
  if (!isObject(managed.result) || managed.result.enabled !== false)
    r2Fail(
      "The target bucket is public or its managed-domain state is unknown.",
    );
  const custom = await get(`${bucketPath}/domains/custom`, "Custom domains");
  if (
    !isObject(custom.result) ||
    !Array.isArray(custom.result.domains) ||
    custom.result.domains.length !== 0
  )
    r2Fail("The target bucket has custom domains or their state is unknown.");
}

export async function checkR2Readiness(env, { fetch: fetchRequest }) {
  try {
    try {
      validateDeployment(env);
    } catch {
      r2Fail("Actions deployment configuration is unauthorized or incomplete.");
    }
    if (env.GITHUB_EVENT_NAME !== "workflow_dispatch")
      r2Fail("Only an explicit manual main Actions run may inspect readiness.");
    const reader = createR2Reader(env, fetchRequest);
    const target = await inspectR2Inventory(reader);
    const worker = await reader.get(
      `${reader.account}/workers/scripts/${WORKER_NAME}/settings`,
      "Worker settings",
    );
    verifyWorkerOwnership(worker.result);
    const bound = verifyWorkerR2Binding(worker.result, { allowAbsent: true });
    if (!target && bound)
      r2Fail("Worker MEDIA binding conflicts with the target bucket.");
    if (!target)
      return "R2 inventory readable; target bucket absent; write permission unverified";
    await verifyR2OwnershipAndPrivacy(reader);
    return "R2 inventory readable; target bucket ownership and private access verified; write permission unverified";
  } catch (error) {
    throw new ReadinessError(
      `R2 readiness: ${error instanceof R2Error ? error.message : "Verification failed."} No changes were made.`,
    );
  }
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
