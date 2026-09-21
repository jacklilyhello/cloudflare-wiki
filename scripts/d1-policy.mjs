import { isAbsolute } from "node:path";
import { WORKER_NAME } from "./deploy-policy.mjs";

export const D1_NAME = "cloudflare-wiki-test";
export const D1_BINDING = "DB";
export const LOCAL_D1_ID = "00000000-0000-0000-0000-000000000000";
export const D1_MARKER = {
  app_id: "jacklilyhello/cloudflare-wiki",
  environment: "test",
  database_name: D1_NAME,
};

export function validateDatabase(database) {
  if (
    database?.name !== D1_NAME ||
    typeof database.uuid !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(database.uuid) ||
    database.uuid === LOCAL_D1_ID
  )
    throw new Error("D1 returned an unexpected database name or identifier.");
  return database.uuid;
}

export function validateD1Config(config) {
  const databases = config.d1_databases;
  const binding = databases?.[0];
  if (
    config.name !== WORKER_NAME ||
    !Array.isArray(databases) ||
    databases.length !== 1 ||
    binding?.binding !== D1_BINDING ||
    binding.database_name !== D1_NAME ||
    binding.database_id !== LOCAL_D1_ID ||
    binding.remote !== false ||
    binding.preview_database_id !== undefined ||
    binding.migrations_table !== undefined ||
    binding.migrations_pattern !== undefined
  )
    throw new Error(
      "Deployment requires the fixed local-only DB placeholder binding.",
    );
}

export function resolveD1Config(config, databaseId, migrationsDirectory) {
  validateD1Config(config);
  validateDatabase({ name: D1_NAME, uuid: databaseId });
  if (!isAbsolute(migrationsDirectory))
    throw new Error("The deployment migrations directory must be absolute.");
  return {
    ...config,
    d1_databases: [
      {
        binding: D1_BINDING,
        database_name: D1_NAME,
        database_id: databaseId,
        migrations_dir: migrationsDirectory,
        remote: false,
      },
    ],
  };
}

export function validateMigrationNames(names) {
  if (
    !Array.isArray(names) ||
    !names.length ||
    names.some(
      (name) =>
        typeof name !== "string" || !/^\d{4}_[a-z0-9_]+\.sql$/.test(name),
    ) ||
    new Set(names.map((name) => name.slice(0, 4))).size !== names.length
  )
    throw new Error("D1 migrations must have unique numbered SQL filenames.");
  const ordered = [...names].sort();
  if (ordered[0] !== "0001_project.sql")
    throw new Error(
      "The first D1 migration must establish the project ownership marker.",
    );
  return ordered;
}

export function validateMarker(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    Object.entries(D1_MARKER).some(([key, value]) => rows[0]?.[key] !== value)
  )
    throw new Error(
      "D1 ownership marker is missing or different; refusing to modify this database.",
    );
}

export function validateMigrationLedger(rows, expectedNames, complete = false) {
  if (
    !Array.isArray(rows) ||
    rows.some((row, index) => row?.name !== expectedNames[index]) ||
    rows.length > expectedNames.length ||
    (complete && rows.length !== expectedNames.length)
  )
    throw new Error(
      "D1 migration ledger does not match the reviewed migration files.",
    );
  return rows.length;
}

export function verifyWorkerD1Binding(
  settings,
  databaseId,
  { allowAbsent = false } = {},
) {
  const bindings =
    settings?.bindings?.filter(
      (binding) => binding.type === "d1" || binding.name === D1_BINDING,
    ) ?? [];
  if (allowAbsent && bindings.length === 0) return;
  // Cloudflare documents database_id, while current Wrangler also reads the
  // legacy settings field id. Accept either, but never conflicting values.
  const binding = bindings[0];
  const boundId = binding?.database_id ?? binding?.id;
  if (
    typeof databaseId !== "string" ||
    bindings.length !== 1 ||
    binding.type !== "d1" ||
    binding.name !== D1_BINDING ||
    boundId !== databaseId ||
    (binding.database_id !== undefined &&
      binding.id !== undefined &&
      binding.database_id !== binding.id)
  )
    throw new Error(
      "Worker DB binding does not match the verified project database.",
    );
}
