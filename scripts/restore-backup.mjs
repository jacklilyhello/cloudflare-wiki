import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import {
  backupSchema,
  canonical,
  fail,
  insertStatement,
  readArchive,
  restoredRows,
  searchStatement,
  sha256,
  snapshotRows,
} from "./backup-format.mjs";

export async function isolatedDirectory(output) {
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const path = resolve(output);
  const parent = await realpath(dirname(path));
  const within = relative(root, parent);
  if (
    !within ||
    (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  )
    fail("Restore requires an unused directory outside the checkout.");
  // Exclusive creation also rejects existing directories, symlinks and local
  // development storage. This tool has no remote target/credential option.
  await mkdir(path, { mode: 0o700 });
  return path;
}
export async function restoreBackup(bytes, output, { inspect } = {}) {
  const schema = backupSchema();
  const backup = readArchive(bytes, schema);
  const directory = await isolatedDirectory(output);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        "export default { fetch() { return new Response(null,{status:404}); } }",
      host: "127.0.0.1",
      port: 0,
      log: new Log(LogLevel.NONE),
      compatibilityDate: "2026-09-18",
      resourcePersistencePath: directory,
      d1Databases: { DB: "isolated-restored-wiki" },
      r2Buckets: { MEDIA: "isolated-restored-media" },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    const bucket = await mf.getR2Bucket("MEDIA");
    const versions = new Map();
    for (const object of backup.payload.objects) {
      const body = Buffer.from(object.body, "base64");
      const metadata = { ...object.httpMetadata };
      if (metadata.cacheExpiry !== undefined)
        metadata.cacheExpiry = new Date(metadata.cacheExpiry);
      const stored = await bucket.put(object.key, body, {
        httpMetadata: metadata,
        customMetadata: object.customMetadata,
        sha256: object.sha256,
      });
      const readback = await bucket.get(object.key);
      if (
        !stored ||
        !readback ||
        sha256(Buffer.from(await readback.arrayBuffer())) !== object.sha256 ||
        readback.version !== stored.version ||
        canonical(
          Object.fromEntries(
            Object.entries(readback.httpMetadata ?? {}).map(([key, value]) => [
              key,
              value instanceof Date ? value.toISOString() : value,
            ]),
          ),
        ) !==
          canonical(
            Object.fromEntries(
              Object.entries(metadata).map(([key, value]) => [
                key,
                value instanceof Date ? value.toISOString() : value,
              ]),
            ),
          ) ||
        canonical(readback.customMetadata) !== canonical(object.customMetadata)
      )
        fail("Isolated R2 readback failed.");
      versions.set(object.key, stored.version);
    }
    const tables = restoredRows(backup.payload.tables, versions);
    const statements = [db.prepare("PRAGMA defer_foreign_keys=ON")];
    // Constraints remain active. Audit/immutability triggers are installed only
    // after the historical rows are restored into this brand-new database.
    for (const definition of schema.definitions.filter(
      (item) => item.type === "table",
    ))
      statements.push(db.prepare(definition.sql));
    for (const table of schema.tables)
      for (const row of tables[table.name] ?? []) {
        const statement = insertStatement(table.name, row);
        statements.push(db.prepare(statement.sql).bind(...statement.params));
      }
    await db.batch(statements);
    const searchRows = (
      await db.prepare("SELECT rowid,* FROM published_search").all()
    ).results;
    if (searchRows.length)
      await db.batch(
        searchRows.map((row) => {
          const statement = searchStatement(row);
          return db.prepare(statement.sql).bind(...statement.params);
        }),
      );
    const protections = schema.definitions.filter(
      (item) => item.type !== "table",
    );
    if (protections.length)
      await db.batch(protections.map((item) => db.prepare(item.sql)));
    await db
      .prepare(
        "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
      )
      .run();
    await db.batch(
      schema.migrations.map((item) =>
        db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(item.name),
      ),
    );
    const restored = snapshotRows(
      (await db.prepare(schema.query).all()).results,
      schema,
    );
    const expected = snapshotRows(
      Object.entries(tables).flatMap(([collection, rows]) =>
        rows.map((row) => {
          const columns = schema.captured.find(
            (table) => table.name === collection,
          ).columns;
          return {
            collection,
            record: JSON.stringify(
              Object.fromEntries(
                columns.map((column) => [column, row[column]]),
              ),
            ),
          };
        }),
      ),
      schema,
    );
    if (canonical(restored) !== canonical(expected))
      fail("Restored entity comparison failed.");
    if (
      (await db.prepare("PRAGMA foreign_key_check").all()).results.length ||
      (await db.prepare("PRAGMA quick_check").first()).quick_check !== "ok"
    )
      fail("Restored database integrity failed.");
    const invalid = await db
      .prepare(`SELECT count(*) AS n FROM page_translations t LEFT JOIN published_search s ON s.translation_id=t.id WHERE
      (t.published_revision_id IS NOT NULL AND (t.deleted_at IS NOT NULL OR s.revision_id IS NOT t.published_revision_id OR s.path IS NOT t.slug OR s.language IS NOT t.language))
      OR (t.published_revision_id IS NULL AND s.translation_id IS NOT NULL)`)
      .first();
    if (
      invalid.n !== 0 ||
      (
        await db
          .prepare("SELECT count(*) AS n FROM published_search_fts")
          .first()
      ).n !== searchRows.length
    )
      fail("Restored public/search state mismatch.");
    await db
      .prepare(
        "INSERT INTO published_search_fts(published_search_fts) VALUES('integrity-check')",
      )
      .run();
    if (
      (await db.prepare("SELECT count(*) AS n FROM admin_sessions").first())
        .n ||
      (await db.prepare("SELECT count(*) AS n FROM admin_login_limits").first())
        .n
    )
      fail("Restored transient credentials were not cleared.");
    if (inspect) await inspect({ db, bucket, backup, tables });
    return {
      verifiedAt: new Date().toISOString(),
      snapshotAt: backup.createdAt,
      tables: Object.fromEntries(
        Object.entries(restored).map(([name, rows]) => [name, rows.length]),
      ),
      objects: backup.payload.objects.length,
      attachmentBytes: backup.payload.objects.reduce(
        (sum, object) => sum + object.size,
        0,
      ),
      foreignKeys: "ok",
      integrity: "ok",
      quickCheck: "ok",
      publicState: "equal",
      search: "rebuilt",
      credentials: "locked",
      sessions: 0,
    };
  } finally {
    await mf.dispose();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [archive, output, ...extra] = process.argv.slice(2);
  if (!archive || !output || extra.length) {
    console.error(
      "Usage: node scripts/restore-backup.mjs PRIVATE_ARCHIVE NEW_PRIVATE_DIRECTORY",
    );
    process.exitCode = 1;
  } else
    restoreBackup(await readFile(archive), output)
      .then((result) => console.log(JSON.stringify(result)))
      .catch(() => {
        console.error(
          "Isolated restore failed; no remote operation was attempted. Do not reuse the incomplete destination.",
        );
        process.exitCode = 1;
      });
}
