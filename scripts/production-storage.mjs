import { resolveD1Config, verifyWorkerD1Binding } from "./d1-policy.mjs";
import { inspectD1 } from "./d1-provision.mjs";
import {
  validateR2Config,
  validateR2StorageClass,
  verifyWorkerOwnership,
  verifyWorkerR2Binding,
} from "./r2-policy.mjs";
import {
  createR2Reader,
  inspectR2Inventory,
  verifyR2OwnershipAndPrivacy,
} from "./r2-readiness.mjs";

// Production adopts only the already bound, marked, fully migrated resources.
// This path has no provisioner, remote migration, bootstrap or storage writer.
export async function productionStorage(input, { fetch: fetchRequest }) {
  validateR2Config(input.config);
  verifyWorkerOwnership(input.workerSettings);
  verifyWorkerR2Binding(input.workerSettings);
  const inspected = await inspectD1(input, { fetch: fetchRequest });
  if (
    inspected.state !== "owned" ||
    inspected.appliedCount !== inspected.expectedNames.length
  )
    throw new Error(
      "Production requires the existing D1 and its complete reviewed migration ledger; no creation or migration was attempted.",
    );
  verifyWorkerD1Binding(input.workerSettings, inspected.databaseId);
  const reader = createR2Reader(input.env, fetchRequest);
  const bucket = await inspectR2Inventory(reader);
  if (!bucket)
    throw new Error("Production requires the existing private R2 bucket.");
  validateR2StorageClass(bucket);
  await verifyR2OwnershipAndPrivacy(reader);
  return {
    databaseId: inspected.databaseId,
    config: resolveD1Config(
      input.config,
      inspected.databaseId,
      input.migrationsDirectory,
    ),
  };
}
