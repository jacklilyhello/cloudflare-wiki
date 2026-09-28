import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { indexSearchText } from "../shared/search.ts";
import { validateMarker } from "./d1-policy.mjs";
import { R2_OWNER_KEY, validateR2Marker } from "./r2-policy.mjs";

export const BACKUP_PREFIX = "__wiki_backups_v1/";
export const LIMITS = Object.freeze({
  rows: 20000,
  database: 32 * 1024 * 1024,
  object: 20 * 1024 * 1024,
  attachments: 128 * 1024 * 1024,
  archive: 220 * 1024 * 1024,
  objects: 2000,
  retained: 90,
  retainedBytes: 1024 * 1024 * 1024,
});
export class BackupError extends Error {}
export function fail(message = "Backup validation failed.") {
  throw new BackupError(message);
}
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const excluded = new Set(["admin_sessions", "admin_login_limits"]);
const hidden = {
  administrators: ["password_hash"],
  admin_bootstrap: ["token_hash", "expires_at"],
};
const identifier = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail();
  return `"${name}"`;
};

// Derive schema only from the checked-out, reviewed migrations. No SQL from a
// backup is ever executed. FTS shadow tables are rebuilt, not copied or dropped
// on the source. Auth secrets and transient session/rate-limit rows never leave D1.
export function backupSchema() {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(new URL(name, directory), "utf8");
      db.exec(sql);
      return { name, sha256: sha256(sql) };
    });
  const definitions = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'published_search_fts_*' ORDER BY type,name",
    )
    .all();
  const tables = definitions
    .filter(
      (item) => item.type === "table" && item.name !== "published_search_fts",
    )
    .map((item) => ({
      name: item.name,
      sql: item.sql,
      columns: db
        .prepare(`PRAGMA table_info(${identifier(item.name)})`)
        .all()
        .map((column) => column.name),
    }));
  const captured = tables
    .filter((table) => !excluded.has(table.name))
    .map((table) => ({
      ...table,
      columns: table.columns.filter(
        (column) => !hidden[table.name]?.includes(column),
      ),
    }));
  const selects = captured.map(
    (table) =>
      `SELECT '${table.name}' AS collection,json_object(${table.columns.map((column) => `'${column}',${identifier(column)}`).join(",")}) AS record FROM ${identifier(table.name)}`,
  );
  // D1 limits terms per compound SELECT. Materialized groups keep every
  // compound below five terms while preserving one statement/snapshot and
  // individual rows (no oversized table-wide JSON aggregate).
  const groups = [];
  for (let index = 0; index < selects.length; index += 5)
    groups.push(selects.slice(index, index + 5).join(" UNION ALL "));
  if (groups.length > 5)
    fail("Snapshot schema requires a reviewed query expansion.");
  const query = `WITH ${groups.map((group, index) => `snapshot_${index} AS MATERIALIZED (${group} LIMIT ${LIMITS.rows + 1})`).join(",")} ${groups.map((_, index) => `SELECT * FROM snapshot_${index}`).join(" UNION ALL ")} ORDER BY collection,record LIMIT ${LIMITS.rows + 1}`;
  db.close();
  return { migrations, definitions, tables, captured, query };
}
export function snapshotRows(rows, schema) {
  if (
    !Array.isArray(rows) ||
    rows.length > LIMITS.rows ||
    Buffer.byteLength(JSON.stringify(rows)) > LIMITS.database
  )
    fail(
      "Database snapshot exceeds its bounded size; no partial backup is accepted.",
    );
  const result = Object.fromEntries(
    schema.captured.map((table) => [table.name, []]),
  );
  for (const item of rows) {
    const table = schema.captured.find(
      (table) => table.name === item.collection,
    );
    if (!table || typeof item.record !== "string") fail();
    const row = JSON.parse(item.record);
    if (
      !row ||
      canonical(Object.keys(row).sort()) !==
        canonical([...table.columns].sort()) ||
      Object.values(row).some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          !(typeof value === "number" && Number.isSafeInteger(value)),
      )
    )
      fail();
    result[table.name].push(row);
  }
  for (const rows of Object.values(result))
    rows.sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
  validateMarker(result.project_metadata);
  if (
    result.administrators.length !== 1 ||
    result.administrators[0].id !== 1 ||
    result.admin_bootstrap.length !== 1 ||
    !result.admin_bootstrap[0].consumed_at
  )
    fail(
      "Backup requires the original initialized administrator and closed setup.",
    );
  return result;
}
export function validateObjects(objects, tables) {
  if (!Array.isArray(objects) || objects.length > LIMITS.objects) fail();
  const seen = new Set();
  let total = 0;
  for (const object of objects) {
    if (
      !object ||
      typeof object.key !== "string" ||
      object.key.startsWith(BACKUP_PREFIX) ||
      seen.has(object.key) ||
      !/^(?:files\/[0-9a-f-]{36}|__cloudflare_wiki_owner_v1\.json)$/.test(
        object.key,
      ) ||
      typeof object.body !== "string" ||
      object.body.length > Math.ceil(LIMITS.object / 3) * 4
    )
      fail();
    seen.add(object.key);
    const bytes = Buffer.from(object.body, "base64");
    total += bytes.length;
    if (
      bytes.toString("base64") !== object.body ||
      bytes.length !== object.size ||
      sha256(bytes) !== object.sha256 ||
      total > LIMITS.attachments
    )
      fail("Attachment length or checksum verification failed.");
    if (object.key === R2_OWNER_KEY)
      validateR2Marker(JSON.parse(bytes.toString("utf8")));
    if (
      !object.customMetadata ||
      typeof object.customMetadata !== "object" ||
      Array.isArray(object.customMetadata) ||
      Object.values(object.customMetadata).some(
        (value) => typeof value !== "string",
      ) ||
      !object.httpMetadata ||
      typeof object.httpMetadata !== "object" ||
      Array.isArray(object.httpMetadata) ||
      Object.values(object.httpMetadata).some(
        (value) => typeof value !== "string",
      ) ||
      Buffer.byteLength(
        canonical([object.customMetadata, object.httpMetadata]),
      ) > 16384
    )
      fail();
  }
  for (const descriptor of tables.file_objects) {
    const object = objects.find(
      (object) => object.key === descriptor.object_key,
    );
    if (!object) {
      if (descriptor.verified_at !== null)
        fail("A verified attachment is missing; backup stopped.");
      continue;
    }
    const metadata = object.customMetadata;
    if (
      Object.keys(metadata).length !== 11 ||
      metadata.schema !== "1" ||
      object.size !== descriptor.expected_bytes ||
      object.sha256 !== descriptor.expected_sha256 ||
      metadata.fileId !== descriptor.file_id ||
      metadata.objectId !== descriptor.id ||
      metadata.role !== descriptor.role ||
      metadata.receiptToken !== descriptor.receipt_token ||
      metadata.sha256 !== descriptor.expected_sha256 ||
      metadata.bytes !== String(descriptor.expected_bytes) ||
      metadata.mimeHint !== descriptor.mime_hint ||
      object.httpMetadata.contentType !== descriptor.mime_hint ||
      object.httpMetadata.contentEncoding !== undefined
    )
      fail("Attachment metadata does not match D1.");
    if (
      descriptor.verified_at !== null &&
      (metadata.mime !== descriptor.mime ||
        metadata.width !==
          (descriptor.width === null ? "" : String(descriptor.width)) ||
        metadata.height !==
          (descriptor.height === null ? "" : String(descriptor.height)))
    )
      fail("Verified attachment dimensions differ from D1.");
  }
  if (!seen.has(R2_OWNER_KEY))
    fail("R2 ownership marker is missing from the backup.");
  return total;
}
export function createArchive(
  {
    tables,
    objects,
    sourceSha,
    branding,
    createdAt = new Date().toISOString(),
  },
  schema,
) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail();
  validateObjects(objects, tables);
  const payload = {
    tables,
    objects,
    ...(branding === undefined ? {} : { branding }),
  };
  const backup = {
    format: "cloudflare-wiki-backup",
    version: branding === undefined ? 1 : 2,
    createdAt,
    sourceSha,
    migrations: schema.migrations,
    payloadSha256: sha256(canonical(payload)),
    payload,
  };
  const bytes = Buffer.from(canonical(backup));
  if (bytes.length > LIMITS.archive)
    fail("Backup exceeds its bounded archive size.");
  return gzipSync(bytes);
}
export function readArchive(bytes, schema) {
  if (bytes.length > LIMITS.archive) fail();
  const backup = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: LIMITS.archive }).toString("utf8"),
  );
  if (
    backup?.format !== "cloudflare-wiki-backup" ||
    ![1, 2].includes(backup.version) ||
    canonical(backup.migrations) !== canonical(schema.migrations) ||
    !/^[a-f0-9]{40}$/.test(backup.sourceSha) ||
    typeof backup.createdAt !== "string" ||
    !Number.isFinite(Date.parse(backup.createdAt)) ||
    backup.payloadSha256 !== sha256(canonical(backup.payload))
  )
    fail("Backup version, migrations or integrity verification failed.");
  const payload = backup.payload;
  if ((backup.version === 2) !== Object.hasOwn(payload ?? {}, "branding"))
    fail("Backup branding version is inconsistent.");
  if (
    !payload?.tables ||
    canonical(Object.keys(payload.tables).sort()) !==
      canonical(schema.captured.map((table) => table.name).sort())
  )
    fail();
  const tables = snapshotRows(
    Object.entries(payload.tables).flatMap(([collection, rows]) => {
      if (!Array.isArray(rows)) fail();
      return rows.map((row) => ({ collection, record: JSON.stringify(row) }));
    }),
    schema,
  );
  validateObjects(payload.objects, tables);
  return {
    ...backup,
    payload: {
      tables,
      objects: payload.objects,
      ...(backup.version === 2 ? { branding: payload.branding } : {}),
    },
  };
}
export function restoredRows(tables, versions, now = Date.now()) {
  const result = structuredClone(tables);
  const admin = result.administrators[0];
  if (!Number.isSafeInteger(admin.auth_version + 1)) fail();
  // Random verifier with no known password; only owner recovery can unlock it.
  admin.password_hash = `scrypt$16384$8$5$${randomBytes(16).toString("base64url")}$${randomBytes(32).toString("base64url")}`;
  admin.auth_version++;
  admin.updated_at = now;
  result.admin_bootstrap[0].token_hash = randomBytes(32).toString("hex");
  result.admin_bootstrap[0].expires_at = 0;
  for (const row of result.file_objects)
    if (row.verified_at !== null) {
      if (!versions.has(row.object_key)) fail();
      row.r2_version = versions.get(row.object_key);
    }
  return result;
}
export function insertStatement(name, row) {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${identifier(name)} (${columns.map(identifier).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    params: columns.map((column) => row[column]),
  };
}
export function searchStatement(row) {
  return {
    sql: "INSERT INTO published_search_fts(rowid,translation_id,language,title,tags,description,path,body) VALUES(?,?,?,?,?,?,?,?)",
    params: [
      row.rowid,
      row.translation_id,
      row.language,
      ...[
        row.title,
        JSON.parse(row.tags_json).join(" "),
        row.description,
        row.path,
        row.body_text,
      ].map(indexSearchText),
    ],
  };
}
