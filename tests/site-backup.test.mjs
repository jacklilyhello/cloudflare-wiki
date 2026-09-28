import assert from "node:assert/strict";
import { randomUUID, scryptSync } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  backupSchema,
  canonical,
  createArchive,
  LIMITS,
  readArchive,
  sha256,
  snapshotRows,
} from "../scripts/backup-format.mjs";
import { backupR2, boundedBytes } from "../scripts/backup-r2.mjs";
import { restoreBackup } from "../scripts/restore-backup.mjs";
import {
  captureSnapshot,
  validateBackupContext,
  runBackup,
} from "../scripts/site-backup.mjs";
import { R2_OWNER, R2_OWNER_KEY, R2_BUCKET } from "../scripts/r2-policy.mjs";
import { recoveryStatement } from "../shared/admin-recovery.ts";
import { prepareRecovery } from "../scripts/administrator-recovery.mjs";

const schema = backupSchema();
const sourceSha = "a".repeat(40);
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  t.after(() => db.close());
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const password = "isolated-pre-backup-password";
  const salt = Buffer.alloc(16, 4);
  const hash = `scrypt$16384$8$5$${salt.toString("base64url")}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }).toString("base64url")}`;
  db.prepare(
    "INSERT INTO administrators(id,username,password_hash,created_at,updated_at) VALUES(1,'original-owner',?,?,?)",
  ).run(hash, now, now);
  db.prepare("INSERT INTO admin_bootstrap VALUES(1,?,?,?)").run(
    "b".repeat(64),
    now - 1000,
    now - 2000,
  );
  db.prepare("INSERT INTO admin_sessions VALUES(?,1,1,?,?,?)").run(
    "c".repeat(64),
    now,
    now + 60000,
    now,
  );
  db.prepare(
    "INSERT INTO admin_login_limits VALUES('private-ip-digest',?,1)",
  ).run(now);
  const page = db
    .prepare(
      "SELECT * FROM page_translations WHERE language='zh' ORDER BY id LIMIT 1",
    )
    .get();
  const revision = db
    .prepare("SELECT * FROM page_revisions WHERE id=?")
    .get(page.draft_revision_id);
  db.prepare(
    "INSERT INTO page_revisions(id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) VALUES('backup-new-draft',?,2,'Unpublished draft','',?,'[]','Draft fixture',?)",
  ).run(page.id, "Draft-only text [relative](./elsewhere)", iso);
  db.prepare(
    "UPDATE page_translations SET draft_revision_id='backup-new-draft',revision_seq=2,write_version=write_version+1 WHERE id=?",
  ).run(page.id);
  db.prepare(
    "INSERT INTO page_routes(language,path,translation_id,created_at) VALUES('zh','backup-old-alias',?,?)",
  ).run(page.id, iso);
  db.prepare(
    "INSERT INTO navigation_nodes(language,id,position,kind,translation_id) VALUES('zh','backup-nav',0,'page',?)",
  ).run(page.id);
  db.prepare(
    "UPDATE navigation_trees SET mode='custom',version=version+1,updated_at=? WHERE language='zh'",
  ).run(iso);
  const fileId = randomUUID();
  const objectId = randomUUID();
  const key = `files/${objectId}`;
  const body = Buffer.from("Synthetic binary attachment\0中文\xff", "utf8");
  const receipt = "d".repeat(64);
  const digest = sha256(body);
  db.exec("BEGIN; PRAGMA defer_foreign_keys=ON;");
  db.prepare(
    "INSERT INTO file_entries(id,kind,name,name_key,version,state,thumbnail_state,source_object_id,upload_auth_version,upload_expires_at,created_at,updated_at) VALUES(?,'file','fixture.bin','fixture.bin',1,'pending','none',?,1,?,?,?)",
  ).run(fileId, objectId, new Date(now + 60000).toISOString(), iso, iso);
  db.prepare(
    "INSERT INTO file_objects(id,file_id,role,object_key,receipt_token,expected_bytes,expected_sha256,mime_hint) VALUES(?,?,'source',?,?,?,?,'application/octet-stream')",
  ).run(objectId, fileId, key, receipt, body.length, digest);
  db.exec("COMMIT");
  db.prepare(
    "UPDATE file_objects SET verified_at=?,r2_version='original-provider-version',mime='application/octet-stream' WHERE id=?",
  ).run(iso, objectId);
  db.prepare(
    "UPDATE file_entries SET state='ready',version=version+1,updated_at=? WHERE id=?",
  ).run(iso, fileId);
  db.prepare(
    "UPDATE file_entries SET published_at=?,version=version+1,updated_at=? WHERE id=?",
  ).run(iso, iso, fileId);
  const objects = [
    {
      key,
      size: body.length,
      sha256: digest,
      body: body.toString("base64"),
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        schema: "1",
        fileId,
        objectId,
        role: "source",
        receiptToken: receipt,
        bytes: String(body.length),
        sha256: digest,
        mimeHint: "application/octet-stream",
        mime: "application/octet-stream",
        width: "",
        height: "",
      },
    },
  ];
  const marker = Buffer.from(JSON.stringify(R2_OWNER));
  objects.push({
    key: R2_OWNER_KEY,
    size: marker.length,
    sha256: sha256(marker),
    body: marker.toString("base64"),
    customMetadata: {},
    httpMetadata: { contentType: "application/json" },
  });
  const tables = snapshotRows(db.prepare(schema.query).all(), schema);
  return { db, tables, objects, body, key, page, revision, password, hash };
}
function privateDirectory(t) {
  const parent = mkdtempSync(join(tmpdir(), "wiki-backup-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return join(parent, "restored");
}
test("private backup restores D1/R2, draft versus published state, navigation, aliases, immutable history and locked auth", async (t) => {
  const f = fixture(t);
  const output = privateDirectory(t);
  const bytes = createArchive({ ...f, sourceSha }, schema);
  const decoded = gunzipSync(bytes).toString("utf8");
  for (const secret of [
    f.password,
    f.hash,
    "c".repeat(64),
    "private-ip-digest",
  ])
    assert.equal(decoded.includes(secret), false);
  const report = await restoreBackup(bytes, output, {
    inspect: async ({ db, bucket, tables }) => {
      const page = await db
        .prepare("SELECT * FROM page_translations WHERE id=?")
        .bind(f.page.id)
        .first();
      assert.equal(page.draft_revision_id, "backup-new-draft");
      assert.equal(page.published_revision_id, f.revision.id);
      assert.equal(
        (
          await db
            .prepare("SELECT markdown FROM page_revisions WHERE id=?")
            .bind(f.revision.id)
            .first()
        ).markdown,
        f.revision.markdown,
      );
      assert.ok(
        (
          await db
            .prepare(
              "SELECT * FROM published_search_fts WHERE published_search_fts MATCH 'markdown'",
            )
            .all()
        ).results.length,
      );
      const object = await bucket.get(f.key);
      assert.deepEqual(Buffer.from(await object.arrayBuffer()), f.body);
      assert.equal(
        (await db.prepare("SELECT r2_version FROM file_objects").first())
          .r2_version,
        object.version,
      );
      assert.notEqual(object.version, "original-provider-version");
      await assert.rejects(
        db.prepare("UPDATE page_revisions SET title='mutated'").run(),
      );
      await assert.rejects(db.prepare("DELETE FROM audit_records").run());
      const admin = await db.prepare("SELECT * FROM administrators").first();
      assert.equal(admin.id, 1);
      assert.equal(admin.username, "original-owner");
      assert.equal(admin.auth_version, 2);
      assert.notEqual(admin.password_hash, f.hash);
      assert.equal(tables.audit_records.length, f.tables.audit_records.length);
      const parts = admin.password_hash.split("$");
      assert.notEqual(
        scryptSync(f.password, Buffer.from(parts[4], "base64url"), 32, {
          N: 16384,
          r: 8,
          p: 5,
          maxmem: 32 * 1024 * 1024,
        }).toString("base64url"),
        parts[5],
      );
      const prepared = await prepareRecovery(
        JSON.stringify({
          password: "isolated-after-restore-password",
          token: Buffer.alloc(32, 7).toString("base64url"),
          expectedVersion: 2,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      );
      const recovery = recoveryStatement(prepared);
      assert.equal(
        (
          await db
            .prepare(recovery.sql)
            .bind(...recovery.params)
            .all()
        ).results[0].auth_version,
        3,
      );
      assert.equal(
        (await db.prepare("SELECT count(*) AS n FROM administrators").first())
          .n,
        1,
      );
    },
  });
  assert.equal(report.publicState, "equal");
  assert.equal(report.foreignKeys, "ok");
  assert.equal(report.objects, 2);
  assert.equal(
    report.attachmentBytes,
    f.objects.reduce((n, o) => n + o.size, 0),
  );
  assert.equal(report.tables.page_revisions, f.tables.page_revisions.length);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  console.log(`Synthetic isolated restore: ${JSON.stringify(report)}`);
  await assert.rejects(restoreBackup(bytes, output));
});
test("corruption, schema drift, omitted entities, missing files and changed hashes fail before restore", (t) => {
  const f = fixture(t);
  const bytes = createArchive({ ...f, sourceSha }, schema);
  assert.throws(() => readArchive(Buffer.from("not-gzip"), schema));
  assert.throws(
    () => readArchive(bytes, { ...schema, migrations: [] }),
    /migrations/,
  );
  for (const mutate of [
    (b) => {
      b.version = 2;
    },
    (b) => {
      b.payload.tables.pages.pop();
    },
    (b) => {
      b.payload.objects[0].body = "dGFtcGVyZWQ=";
    },
  ]) {
    const b = JSON.parse(gunzipSync(bytes));
    mutate(b);
    assert.throws(() => readArchive(gzipSync(JSON.stringify(b)), schema));
  }
  assert.throws(
    () => createArchive({ ...f, objects: [], sourceSha }, schema),
    /missing/,
  );
  assert.throws(
    () => snapshotRows(Array(LIMITS.rows + 1).fill({}), schema),
    /size/,
  );
});
test("capture rejects concurrent D1 changes, R2 changes, unknown tables and retention caps without writing", async (t) => {
  const f = fixture(t);
  const item = {
    key: f.key,
    size: f.body.length,
    etag: "e".repeat(32),
    last_modified: new Date().toISOString(),
    custom_metadata: f.objects[0].customMetadata,
    http_metadata: f.objects[0].httpMetadata,
  };
  let calls = 0;
  const r2 = {
    list: async () => [
      item,
      {
        key: R2_OWNER_KEY,
        size: f.objects[1].size,
        etag: "a".repeat(32),
        last_modified: item.last_modified,
        custom_metadata: {},
        http_metadata: { contentType: "application/json" },
      },
    ],
    get: async (key) =>
      key === f.key ? f.body : Buffer.from(f.objects[1].body, "base64"),
  };
  const query = async (sql) => f.db.prepare(sql).all();
  const bytes = await captureSnapshot({ query, r2, schema, sourceSha });
  assert.equal(readArchive(bytes, schema).payload.objects.length, 2);
  await assert.rejects(
    captureSnapshot({
      query: async (sql) => {
        if (sql === schema.query && ++calls === 2)
          f.db
            .prepare(
              "UPDATE administrators SET password_hash='changed',auth_version=auth_version+1 WHERE id=1",
            )
            .run();
        return query(sql);
      },
      r2,
      schema,
      sourceSha,
    }),
    /changed during/,
  );
  let lists = 0;
  await assert.rejects(
    captureSnapshot({
      query,
      r2: {
        ...r2,
        list: async () => [
          { ...item, etag: ++lists === 1 ? item.etag : "f".repeat(32) },
        ],
      },
      schema,
      sourceSha,
    }),
    /changed during/,
  );
  await assert.rejects(
    captureSnapshot({
      query,
      r2: {
        ...r2,
        list: async () =>
          Array.from({ length: LIMITS.retained }, (_, i) => ({
            key: `__wiki_backups_v1/${i}`,
            size: 1,
          })),
      },
      schema,
      sourceSha,
    }),
    /retention cap/,
  );
  f.db.exec("CREATE TABLE unknown_private_data(value TEXT)");
  await assert.rejects(
    captureSnapshot({ query, r2, schema, sourceSha }),
    /schema inventory/,
  );
});
test("R2 transport rejects incomplete or looping pagination, unsafe keys, oversized streams and bad upload readback", async () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "fixture-only",
  };
  for (const payload of [
    { success: true, result: [] },
    {
      success: true,
      result: [],
      result_info: { is_truncated: true, cursor: "same" },
    },
    {
      success: true,
      result: [{ key: "../private" }],
      result_info: { is_truncated: false },
    },
  ])
    await assert.rejects(
      backupR2(env, async () => Response.json(payload)).list(),
    );
  await assert.rejects(boundedBytes(new Response("too-long"), 2), /size/);
  await assert.rejects(
    backupR2(env, async () => new Response("wrong")).putArchive(
      `__wiki_backups_v1/${randomUUID()}.json.gz`,
      Buffer.from("expected"),
    ),
    /checksum/,
  );
  let requests = 0;
  const r2 = backupR2(env, async (url, init) => {
    requests++;
    assert.equal(init.redirect, "error");
    assert.equal(url.includes("%2F"), false);
    return new Response("fixture");
  });
  await assert.rejects(r2.get("../private"));
  assert.equal(requests, 0);
  await r2.get(`files/${randomUUID()}`);
  assert.equal(requests, 1);
});
test("only the fixed main backup workflow may write private archives; ordinary deployments cannot trigger it", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sourceSha,
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_WORKFLOW_REF:
      "jacklilyhello/cloudflare-wiki/.github/workflows/site-backup.yml@refs/heads/main",
    BACKUP_OPERATION: "backup",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    CLOUDFLARE_ZONE_ID: "c".repeat(32),
    CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
    TEST_DOMAIN: "cf.emby.wiki",
    CLOUDFLARE_API_TOKEN: "fixture-only",
  };
  validateBackupContext(env);
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REF: "refs/heads/feature/test" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_WORKFLOW_REF: "wrong" },
    { TEST_DOMAIN: "emby.wiki" },
    { BACKUP_OPERATION: "restore-remote" },
  ])
    assert.throws(() => validateBackupContext({ ...env, ...change }));
});
test("valid checksums cannot smuggle SQL, break references or publish a draft", async (t) => {
  const f = fixture(t);
  for (const mutate of [
    (tables) => {
      tables.page_routes[0].translation_id = "missing";
    },
    (tables) => {
      tables.page_translations[0].published_revision_id = null;
      tables.page_translations[0].published_at = null;
    },
    (tables) => {
      tables.pages[0].id = "'); DROP TABLE administrators; --";
    },
  ]) {
    const tables = structuredClone(f.tables);
    mutate(tables);
    const bytes = createArchive(
      { tables, objects: f.objects, sourceSha },
      schema,
    );
    await assert.rejects(restoreBackup(bytes, privateDirectory(t)));
  }
  assert.equal(canonical(f.tables).includes("DROP TABLE"), false);
});

test("Actions backup and verify-latest reuse owned private resources and never mutate source D1 or attachment keys", async (t) => {
  const f = fixture(t);
  const databaseId = "12345678-1234-1234-1234-123456789abc";
  f.db.exec("CREATE TABLE d1_migrations(name TEXT)");
  for (const migration of schema.migrations)
    f.db.prepare("INSERT INTO d1_migrations VALUES(?)").run(migration.name);
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "jacklilyhello/cloudflare-wiki",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sourceSha,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF:
      "jacklilyhello/cloudflare-wiki/.github/workflows/site-backup.yml@refs/heads/main",
    BACKUP_OPERATION: "backup",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    CLOUDFLARE_ZONE_ID: "c".repeat(32),
    CLOUDFLARE_WORKER_NAME: "cloudflare-wiki",
    TEST_DOMAIN: "cf.emby.wiki",
    CLOUDFLARE_API_TOKEN: "fixture-only",
  };
  const objects = new Map(
    f.objects.map((o) => [
      o.key,
      { ...o, bytes: Buffer.from(o.body, "base64") },
    ]),
  );
  let writes = 0;
  let isPublic = false;
  const fetchRequest = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    assert.equal(init.redirect, "error");
    if (path.endsWith("/settings"))
      return Response.json({
        success: true,
        result: {
          bindings: [
            { name: "APP_ID", type: "plain_text", text: R2_OWNER.app_id },
            { name: "DB", type: "d1", id: databaseId },
            { name: "MEDIA", type: "r2_bucket", bucket_name: R2_BUCKET },
          ],
        },
      });
    if (path.endsWith("/d1/database"))
      return Response.json({
        success: true,
        result: [{ name: "cloudflare-wiki-test", uuid: databaseId }],
      });
    if (path.endsWith("/query")) {
      const body = JSON.parse(init.body);
      assert.match(body.sql, /^(SELECT|WITH) /);
      return Response.json({
        success: true,
        result: [
          {
            success: true,
            results: f.db.prepare(body.sql).all(...body.params),
          },
        ],
      });
    }
    if (path.endsWith("/domains/managed"))
      return Response.json({ success: true, result: { enabled: isPublic } });
    if (path.endsWith("/domains/custom"))
      return Response.json({ success: true, result: { domains: [] } });
    if (path.endsWith("/objects"))
      return Response.json({
        success: true,
        result: [...objects.values()].map((o) => ({
          key: o.key,
          size: o.bytes.length,
          etag: "a".repeat(32),
          last_modified: "2026-09-28T00:00:00.000Z",
          custom_metadata: o.customMetadata,
          http_metadata: o.httpMetadata,
        })),
        result_info: { is_truncated: false },
      });
    const key = path.split("/objects/")[1];
    assert.ok(key);
    if (method === "PUT") {
      assert.match(key, /^__wiki_backups_v1\//);
      assert.equal(objects.has(key), false);
      assert.equal(init.headers["If-None-Match"], "*");
      writes++;
      objects.set(key, {
        key,
        bytes: Buffer.from(init.body),
        customMetadata: {},
        httpMetadata: { contentType: "application/gzip" },
      });
      return Response.json({ success: true });
    }
    assert.equal(method, "GET");
    return new Response(objects.get(key).bytes);
  };
  const before = canonical(
    snapshotRows(f.db.prepare(schema.query).all(), schema),
  );
  const first = await runBackup(env, { fetch: fetchRequest });
  assert.equal(writes, 1);
  assert.equal(first.readback, "verified");
  assert.equal(first.objects, 2);
  const verified = await runBackup(
    { ...env, BACKUP_OPERATION: "verify-latest" },
    { fetch: fetchRequest },
  );
  assert.equal(writes, 1);
  assert.deepEqual(verified.tables, first.tables);
  assert.equal(
    canonical(snapshotRows(f.db.prepare(schema.query).all(), schema)),
    before,
  );
  isPublic = true;
  await assert.rejects(runBackup(env, { fetch: fetchRequest }));
  assert.equal(writes, 1);
});
