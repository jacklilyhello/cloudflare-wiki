import { validateDeployment } from "./deploy-policy.mjs";
import {
  defaultJurisdiction,
  isObject,
  R2_BUCKET,
  R2_OWNER,
  R2_OWNER_KEY,
  R2Error,
  r2Fail,
  validateR2Config,
  validateR2StorageClass,
  verifyWorkerOwnership,
  verifyWorkerR2Binding,
} from "./r2-policy.mjs";
import {
  createR2Reader,
  inspectR2Inventory,
  readR2Response,
  verifyR2OwnershipAndPrivacy,
} from "./r2-readiness.mjs";

export { validateR2Config, verifyWorkerR2Binding } from "./r2-policy.mjs";

// Inspect D1 ownership/ledger before this call; wait for its verified result
// before any D1 mutations or Worker deployment.
export async function ensureR2(
  { env, config, workerSettings },
  { fetch: fetchRequest },
) {
  let writeAttempted = false;
  try {
    try {
      validateDeployment(env);
    } catch {
      r2Fail("Actions deployment configuration is unauthorized or incomplete.");
    }
    validateR2Config(config);
    if (workerSettings != null) verifyWorkerOwnership(workerSettings);
    const reader = createR2Reader(env, fetchRequest);
    const target = await inspectR2Inventory(reader);
    const bound = verifyWorkerR2Binding(workerSettings, { allowAbsent: true });
    if (!target && bound)
      r2Fail("Worker MEDIA binding conflicts with the target bucket.");
    if (target) {
      validateR2StorageClass(target);
      await verifyR2OwnershipAndPrivacy(reader);
      return { bucketName: R2_BUCKET, created: false };
    }
    async function write(path, method, body, operation) {
      writeAttempted = true;
      let response;
      try {
        response = await fetchRequest(
          `https://api.cloudflare.com/client/v4${path}`,
          {
            method,
            redirect: "error",
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
              "Content-Type": "application/json",
              "cf-r2-jurisdiction": "default",
            },
            body,
            signal: AbortSignal.timeout(30_000),
          },
        );
      } catch {
        r2Fail(`${operation} request failed; outcome may be unknown.`);
      }
      return readR2Response(response, operation);
    }
    // The create operation rejects an already-owned name with HTTP 400. Never
    // reinterpret that conflict as successful creation or adoption.
    const creation = await write(
      `${reader.account}/r2/buckets`,
      "POST",
      JSON.stringify({ name: R2_BUCKET, storageClass: "Standard" }),
      "Creation",
    );
    if (
      !isObject(creation.result) ||
      creation.result.name !== R2_BUCKET ||
      !defaultJurisdiction(creation.result.jurisdiction)
    )
      r2Fail("Creation did not confirm the expected bucket identity.");
    validateR2StorageClass(creation.result);
    // Only this run's confirmed creation permits a marker write. REST PUT is
    // not assumed to provide conditional creation, and no adoption path exists.
    const marker = JSON.stringify(R2_OWNER);
    const uploaded = await write(
      `${reader.bucketPath}/objects/${R2_OWNER_KEY}`,
      "PUT",
      marker,
      "Ownership marker upload",
    );
    if (
      !isObject(uploaded.result) ||
      uploaded.result.key !== R2_OWNER_KEY ||
      uploaded.result.size !== String(Buffer.byteLength(marker))
    )
      r2Fail("Ownership marker upload did not return the expected metadata.");
    await verifyR2OwnershipAndPrivacy(reader);
    return { bucketName: R2_BUCKET, created: true };
  } catch (error) {
    const message =
      error instanceof R2Error ? error.message : "Verification failed.";
    throw new Error(
      `R2 provisioning: ${message} ${writeAttempted ? "Provisioning may be incomplete; no automatic retry, adoption or cleanup was attempted." : "No Cloudflare changes were made."}`,
    );
  }
}
