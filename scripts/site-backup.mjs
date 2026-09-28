import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureBranding } from "./backup-branding.mjs";
import {
  BACKUP_PREFIX,
  BackupError,
  backupSchema,
  canonical,
  createArchive,
  fail,
  LIMITS,
  sha256,
  snapshotRows,
} from "./backup-format.mjs";
import { backupR2, boundedBytes } from "./backup-r2.mjs";
import { validateDeployment } from "./deploy-policy.mjs";
import { ownedD1 } from "./owned-d1.mjs";
import { verifyWorkerR2Binding } from "./r2-policy.mjs";
import {
  createR2Reader,
  verifyR2OwnershipAndPrivacy,
} from "./r2-readiness.mjs";
import { restoreBackup } from "./restore-backup.mjs";

export function validateBackupContext(env) {
  if (
    !["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_WORKFLOW_REF !==
      "jacklilyhello/cloudflare-wiki/.github/workflows/site-backup.yml@refs/heads/main" ||
    !["backup", "verify-latest"].includes(env.BACKUP_OPERATION)
  )
    fail("Backup requires its main scheduled/manual Actions workflow.");
  // Only this fixed backup workflow admits schedule. Existing deployment and
  // provisioning entry points keep their original push/manual-only policy.
  const inspection = { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" };
  validateDeployment(inspection);
  return inspection;
}
export function snapshotReader(env, databaseId, fetchRequest = fetch) {
  return async (sql) => {
    try {
      const response = await fetchRequest(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}/query`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(60000),
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sql, params: [] }),
        },
      );
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        fail();
      }
      const payload = JSON.parse(
        (await boundedBytes(response, LIMITS.database * 2)).toString("utf8"),
      );
      if (
        payload.success !== true ||
        payload.result?.length !== 1 ||
        payload.result[0].success !== true ||
        !Array.isArray(payload.result[0].results)
      )
        fail();
      return payload.result[0].results;
    } catch {
      fail("Bounded read-only D1 snapshot request failed.");
    }
  };
}
export async function captureSnapshot({
  query,
  r2,
  schema = backupSchema(),
  sourceSha,
  branding,
}) {
  const known = new Set([
    ...schema.tables.map((table) => table.name),
    "d1_migrations",
    "published_search_fts",
  ]);
  const inventory = await query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'published_search_fts_*'",
  );
  if (
    inventory.some((row) => !known.has(row.name)) ||
    schema.tables.some(
      (table) => !inventory.some((row) => row.name === table.name),
    )
  )
    fail("Database schema inventory differs from the reviewed migrations.");
  const before = snapshotRows(await query(schema.query), schema);
  const all = await r2.list();
  const archives = all.filter((object) => object.key.startsWith(BACKUP_PREFIX));
  if (
    archives.length >= LIMITS.retained ||
    archives.reduce((sum, item) => sum + item.size, 0) >= LIMITS.retainedBytes
  )
    fail(
      "Backup retention cap reached; owner review and explicit pruning authorization are required. Nothing was deleted.",
    );
  const source = all.filter((object) => !object.key.startsWith(BACKUP_PREFIX));
  if (
    source.length > LIMITS.objects ||
    source.reduce((sum, item) => sum + item.size, 0) > LIMITS.attachments
  )
    fail("Attachment inventory exceeds its bounded size.");
  const objects = [];
  for (const item of source) {
    const bytes = await r2.get(item.key);
    if (bytes.length !== item.size) fail("Attachment changed during backup.");
    objects.push({
      key: item.key,
      size: bytes.length,
      sha256: sha256(bytes),
      body: bytes.toString("base64"),
      customMetadata: item.custom_metadata ?? {},
      httpMetadata: item.http_metadata ?? {},
    });
  }
  const afterObjects = (await r2.list()).filter(
    (object) => !object.key.startsWith(BACKUP_PREFIX),
  );
  const after = snapshotRows(await query(schema.query), schema);
  if (
    canonical(before) !== canonical(after) ||
    canonical(source) !== canonical(afterObjects)
  )
    fail(
      "Content changed during backup. No partial snapshot was accepted; rerun after editing/uploads stop.",
    );
  const bytes = createArchive(
    { tables: before, objects, sourceSha, branding },
    schema,
  );
  if (
    archives.reduce((sum, item) => sum + item.size, 0) + bytes.length >
    LIMITS.retainedBytes
  )
    fail(
      "Backup retention byte cap would be exceeded; nothing was written or deleted.",
    );
  return bytes;
}
export async function runBackup(
  env,
  { fetch: fetchRequest = fetch, restore = restoreBackup } = {},
) {
  const inspection = validateBackupContext(env);
  const schema = backupSchema();
  const { databaseId, api } = await ownedD1(inspection, fetchRequest);
  const settings = await api.get(
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/cloudflare-wiki/settings`,
  );
  verifyWorkerR2Binding(settings);
  const reader = createR2Reader(inspection, fetchRequest);
  await verifyR2OwnershipAndPrivacy(reader);
  const r2 = backupR2(env, fetchRequest);
  const directory = await mkdtemp(join(tmpdir(), "wiki-private-drill-"));
  try {
    let bytes;
    if (env.BACKUP_OPERATION === "verify-latest") {
      const archives = (await r2.list())
        .filter((object) => object.key.startsWith(BACKUP_PREFIX))
        .sort((a, b) => b.last_modified.localeCompare(a.last_modified));
      if (!archives.length) fail("No private backup exists to verify.");
      bytes = await r2.get(archives[0].key, LIMITS.archive);
    } else {
      const branding = await captureBranding(settings, fetchRequest);
      bytes = await captureSnapshot({
        query: snapshotReader(env, databaseId, fetchRequest),
        r2,
        schema,
        sourceSha: env.GITHUB_SHA,
        branding,
      });
      const current = await api.get(
        `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/cloudflare-wiki/settings`,
      );
      if (
        canonical(branding) !==
        canonical(await captureBranding(current, fetchRequest))
      )
        fail("Deployed branding changed during backup; nothing was stored.");
    }
    const report = await restore(bytes, join(directory, "restored"));
    if (env.BACKUP_OPERATION === "backup") {
      const key = `${BACKUP_PREFIX}${randomUUID()}.json.gz`;
      const existing = await r2.list();
      if (existing.some((item) => item.key === key))
        fail("Backup identity collision; nothing was overwritten.");
      // Recheck privacy immediately before storing any private database bytes.
      await verifyR2OwnershipAndPrivacy(reader);
      await r2.putArchive(key, bytes);
    }
    return {
      operation: env.BACKUP_OPERATION,
      ...report,
      archiveBytes: bytes.length,
      readback: "verified",
      retention: "keep all; 90 archives / 1 GiB cap; no automatic deletion",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = { ...process.env };
  delete process.env.CLOUDFLARE_API_TOKEN;
  runBackup(env)
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      // Errors from providers, SQL and the emulator may contain private content.
      // Only approved static errors from this module's validations are surfaced.
      console.error(
        `::error::Site backup/isolated restore failed. ${error instanceof BackupError ? error.message : "Inspect configuration, resource ownership/privacy, schema, size and integrity. No automatic retry, permission expansion, public artifact or remote restore."}`,
      );
      process.exitCode = 1;
    });
}
