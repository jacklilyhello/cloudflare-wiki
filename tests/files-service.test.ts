import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_LIMITS } from "../shared/auth";
import { FILE_LIMITS, type FileEntry, type ObjectInput } from "../shared/files";
import type { ContentWriteAccess } from "../worker/auth/access";
import type {
  ObjectReceipt,
  UploadDescriptor,
} from "../worker/files/contracts";
import { FilesService, getPublicFileObject } from "../worker/files/service";
import { SettingsService } from "../worker/settings/service";
import { seedContentAccess } from "./content-fixture";

const migrations = (env as Env & { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;
let access: ContentWriteAccess;
let service: FilesService;
const source: ObjectInput = {
  bytes: 24,
  sha256: "a".repeat(64),
  mimeHint: "image/png",
};
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
  access = await seedContentAccess(env.DB);
  service = new FilesService(env.DB, access);
});
async function library() {
  return (await service.list()).libraryVersion;
}
async function folder(name = "Folder", parentId: string | null = null) {
  return service.createFolder({
    expectedLibraryVersion: await library(),
    name,
    parentId,
  });
}
async function prepare(
  name = "Picture.png",
  thumbnail = false,
  parentId: string | null = null,
) {
  return service.prepareUpload({
    expectedLibraryVersion: await library(),
    name,
    parentId,
    source,
    ...(thumbnail ? { thumbnail: source } : {}),
  });
}
function objectReceipt(d: UploadDescriptor): ObjectReceipt {
  const image = d.mimeHint !== "application/octet-stream";
  return {
    fileId: d.fileId,
    objectId: d.objectId,
    role: d.role,
    objectKey: d.objectKey,
    receiptToken: d.receiptToken,
    bytes: d.expectedBytes,
    sha256: d.expectedSha256,
    mime: d.mimeHint,
    width: image ? 16 : null,
    height: image ? 12 : null,
    r2Version: `stored-${d.objectId}`,
  };
}
async function finish(
  entry: FileEntry,
  role: "source" | "thumbnail" = "source",
) {
  return service.finishObject(
    objectReceipt(await service.authorizeUpload(entry.id, role, entry.version)),
    entry.version,
  );
}
async function audit() {
  return (
    await env.DB.prepare(
      "SELECT * FROM audit_records WHERE category='file' ORDER BY seq",
    ).all()
  ).results;
}
async function snapshot() {
  return (
    await env.DB.batch([
      env.DB.prepare("SELECT * FROM file_library"),
      env.DB.prepare("SELECT * FROM file_entries ORDER BY id"),
      env.DB.prepare("SELECT * FROM file_objects ORDER BY id"),
      env.DB.prepare("SELECT * FROM audit_records ORDER BY seq"),
    ])
  ).map((result) => result.results);
}
function beforeBatch(action: () => Promise<unknown>) {
  let done = false;
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await action();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("file metadata lifecycle and relational integrity", () => {
  it("prepares both cyclic descriptors atomically, keeps them private and exposes no internal receipt fields", async () => {
    expect(await library()).toBe(1);
    expect(await audit()).toEqual([]);
    const entry = await prepare("  图片.png  ", true);
    expect(entry).toMatchObject({
      name: "图片.png",
      version: 1,
      state: "pending",
      thumbnailState: "pending",
      source: null,
      thumbnail: null,
      publishedAt: null,
    });
    expect(
      Date.parse(entry.uploadExpiresAt ?? "") - Date.parse(entry.createdAt),
    ).toBe(FILE_LIMITS.uploadMs);
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    const descriptor = await service.authorizeUpload(entry.id, "source", 1);
    expect(descriptor.receiptToken).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptor.objectKey).toBe(`files/${descriptor.objectId}`);
    expect(descriptor.uploadAuthVersion).toBe(access.authVersion);
    const dto = JSON.stringify(await service.list());
    for (const secret of [
      descriptor.receiptToken,
      descriptor.objectKey,
      descriptor.objectId,
      descriptor.expectedSha256,
      "uploadAuthVersion",
      "receiptToken",
    ])
      expect(dto).not.toContain(secret);
    expect(await getPublicFileObject(env.DB, entry.id, "source")).toBeNull();
    await expect(
      service.getStoredObject(entry.id, "source"),
    ).rejects.toMatchObject({ status: 404 });
    expect(await library()).toBe(2);
  });

  it("rejects a missing owned descriptor at commit and rolls back the entry, library and audit", async () => {
    const entry = await prepare();
    const before = await snapshot();
    await expect(
      env.DB.prepare(`INSERT INTO file_entries(id,parent_id,kind,name,name_key,version,state,thumbnail_state,source_object_id,upload_auth_version,upload_expires_at,created_at,updated_at)
      SELECT ?,NULL,kind,'Copy','copy',1,state,thumbnail_state,source_object_id,upload_auth_version,upload_expires_at,created_at,updated_at FROM file_entries WHERE id=?`)
        .bind(crypto.randomUUID(), entry.id)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps immutable IDs/keys while renaming and moving, and restores privately", async () => {
    const destination = await folder();
    let entry = await finish(await prepare());
    const original = await service.getStoredObject(entry.id, "source");
    entry = await service.rename(entry.id, {
      expectedVersion: entry.version,
      name: "renamed.png",
    });
    entry = await service.move(entry.id, {
      expectedVersion: entry.version,
      parentId: destination.id,
    });
    entry = await service.updateAlt(entry.id, {
      expectedVersion: entry.version,
      alt: { zh: "  中文说明  ", en: "Image" },
    });
    expect(entry.alt).toEqual({ zh: "中文说明", en: "Image" });
    entry = await service.publish(entry.id, entry.version);
    expect(
      (await getPublicFileObject(env.DB, entry.id, "source"))?.receipt,
    ).toEqual(original.receipt);
    entry = await service.softDelete(entry.id, entry.version);
    expect(await getPublicFileObject(env.DB, entry.id, "source")).toBeNull();
    await expect(
      service.getStoredObject(entry.id, "source"),
    ).rejects.toMatchObject({ status: 404 });
    entry = await service.restore(entry.id, {
      expectedVersion: entry.version,
      parentId: null,
    });
    expect(entry).toMatchObject({
      publishedAt: null,
      deletedAt: null,
      parentId: null,
    });
    expect((await service.getStoredObject(entry.id, "source")).receipt).toEqual(
      original.receipt,
    );
  });

  it("finalizes optional thumbnails separately and publishes without waiting for them", async () => {
    let completed = await finish(await prepare("Complete.png", true));
    completed = await finish(completed, "thumbnail");
    expect(completed.thumbnailState).toBe("ready");
    completed = await service.publish(completed.id, completed.version);
    expect(
      await getPublicFileObject(env.DB, completed.id, "thumbnail"),
    ).not.toBeNull();
    let incomplete = await finish(await prepare("Incomplete.png", true));
    const late = objectReceipt(
      await service.authorizeUpload(
        incomplete.id,
        "thumbnail",
        incomplete.version,
      ),
    );
    incomplete = await service.publish(incomplete.id, incomplete.version);
    expect(incomplete.thumbnailState).toBe("abandoned");
    expect(
      await getPublicFileObject(env.DB, incomplete.id, "source"),
    ).not.toBeNull();
    expect(
      await getPublicFileObject(env.DB, incomplete.id, "thumbnail"),
    ).toBeNull();
    await expect(
      service.finishObject(late, incomplete.version),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("delete closes an unfinished thumbnail and restore never reopens it", async () => {
    let entry = await finish(await prepare("Delete.png", true));
    entry = await service.softDelete(entry.id, entry.version);
    expect(entry.thumbnailState).toBe("abandoned");
    entry = await service.restore(entry.id, {
      expectedVersion: entry.version,
      parentId: null,
    });
    expect(entry).toMatchObject({
      thumbnailState: "abandoned",
      publishedAt: null,
    });
  });

  it("audits metadata edits after thumbnail cancellation as their actual action using names only", async () => {
    let entry = await finish(
      await prepare("Private filename canary.png", true),
    );
    entry = await service.abandon(entry.id, entry.version);
    entry = await service.rename(entry.id, {
      expectedVersion: entry.version,
      name: "Renamed filename canary.png",
    });
    entry = await service.updateAlt(entry.id, {
      expectedVersion: entry.version,
      alt: { zh: "私有说明哨兵", en: "Private alt canary" },
    });
    const events = await audit();
    expect(events.map((event) => event.action)).toEqual([
      "file.prepare",
      "file.finalize",
      "file.abandon",
      "file.rename",
      "file.alt",
    ]);
    expect(JSON.parse(events.at(-1)?.details_json as string)).toEqual({
      changedFields: ["alt.zh", "alt.en"],
    });
    const serialized = JSON.stringify(events);
    for (const secret of [
      "filename canary",
      "私有说明哨兵",
      "Private alt canary",
      "receiptToken",
      "objectKey",
      "sha256",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("abandons pending sources terminally and cancels only the thumbnail for ready files", async () => {
    let pending = await prepare("Pending.png", true);
    pending = await service.abandon(pending.id, pending.version);
    expect(pending).toMatchObject({
      state: "abandoned",
      thumbnailState: "abandoned",
    });
    expect((await service.list()).items).toEqual([]);
    expect((await service.get(pending.id)).state).toBe("abandoned");
    await expect(
      service.restore(pending.id, {
        expectedVersion: pending.version,
        parentId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
    let ready = await finish(await prepare());
    await expect(
      service.abandon(ready.id, ready.version),
    ).rejects.toMatchObject({ status: 409 });
    ready = await finish(await prepare("Thumbnail.png", true));
    expect(await service.abandon(ready.id, ready.version)).toMatchObject({
      state: "ready",
      thumbnailState: "abandoned",
    });
  });

  it("normalizes names, enforces occupied destinations and checks collisions on restore", async () => {
    const first = await folder("  Ａlpha  ");
    await expect(folder("alpha")).rejects.toMatchObject({ status: 409 });
    let deleted = await service.softDelete(first.id, first.version);
    await folder("alpha");
    await expect(
      service.restore(deleted.id, {
        expectedVersion: deleted.version,
        parentId: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const target = await folder("Target");
    deleted = await service.restore(deleted.id, {
      expectedVersion: deleted.version,
      parentId: target.id,
    });
    expect(deleted.parentId).toBe(target.id);
  });

  it("enforces eight folder levels, subtree depth, cycles and empty-only deletion", async () => {
    const levels: FileEntry[] = [];
    for (let i = 0; i < 8; i++)
      levels.push(await folder(`Level${i}`, levels.at(-1)?.id ?? null));
    await expect(folder("Ninth", levels[7]?.id)).rejects.toMatchObject({
      status: 409,
    });
    await prepare("Inside eighth.png", false, levels[7]?.id);
    const top = levels[0] as FileEntry,
      eighth = levels[7] as FileEntry;
    await expect(
      service.move(top.id, {
        expectedVersion: top.version,
        parentId: eighth.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.softDelete(top.id, top.version)).rejects.toMatchObject(
      { status: 409 },
    );
    const subtree = await folder("Subtree");
    await folder("Child", subtree.id);
    await expect(
      service.move(subtree.id, {
        expectedVersion: subtree.version,
        parentId: levels[6]?.id ?? null,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const file = await finish(await prepare("Not a folder.png"));
    await expect(folder("Invalid child", file.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rejects delete, REPLACE, identity changes and unearned version advancement in SQL", async () => {
    const one = await folder("One"),
      two = await folder("Two");
    const upload = await prepare();
    const before = await snapshot();
    for (const sql of [
      "DELETE FROM file_entries",
      "DELETE FROM file_objects",
      "INSERT OR REPLACE INTO file_entries SELECT * FROM file_entries",
      "INSERT OR REPLACE INTO file_objects SELECT * FROM file_objects",
      "UPDATE file_entries SET version=version+1",
      "UPDATE file_entries SET name='Changed',name_key='changed'",
      "UPDATE file_entries SET id='00000000-0000-4000-8000-000000000000'",
      "UPDATE file_objects SET object_key='replacement'",
      "DELETE FROM file_library",
      "INSERT OR REPLACE INTO file_library SELECT * FROM file_library",
    ])
      await expect(env.DB.prepare(sql).run()).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE OR REPLACE file_entries SET name='Two',name_key='two',version=version+1 WHERE id=?",
      )
        .bind(one.id)
        .run(),
    ).rejects.toThrow("files_name");
    expect(await snapshot()).toEqual(before);
    expect((await service.get(two.id)).name).toBe("Two");
    expect((await service.get(upload.id)).state).toBe("pending");
  });

  it("rejects extra UUID hyphens in both entry and file audit SQL inserts", async () => {
    const entry = await folder();
    const before = await snapshot();
    const malformed = "-1111111-1111-4111-8111-111111111111";
    await expect(
      env.DB.prepare(
        "INSERT INTO file_entries(id,kind,name,name_key,version,state,thumbnail_state,created_at,updated_at) SELECT ?,'folder','Bad','bad',1,'ready','none',created_at,updated_at FROM file_entries WHERE id=?",
      )
        .bind(malformed, entry.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO audit_records(category,subject_id,subject_version,action,language,origin,details_json,created_at) VALUES('file',?,1,'file.create_folder',NULL,'current','{\"changedFields\":[\"name\"]}',?)",
      )
        .bind(malformed, new Date().toISOString())
        .run(),
    ).rejects.toThrow("audit_invalid");
    expect(await snapshot()).toEqual(before);
  });
});

describe("file CAS, authorization and receipts", () => {
  it("does not change timestamps, versions or audits for normalized no-ops", async () => {
    let entry = await finish(await prepare());
    const before = await snapshot();
    expect(
      await service.rename(entry.id, {
        expectedVersion: entry.version,
        name: " Picture.png ",
      }),
    ).toEqual(entry);
    expect(
      await service.move(entry.id, {
        expectedVersion: entry.version,
        parentId: null,
      }),
    ).toEqual(entry);
    expect(
      await service.updateAlt(entry.id, {
        expectedVersion: entry.version,
        alt: { zh: " ", en: "" },
      }),
    ).toEqual(entry);
    expect(await service.unpublish(entry.id, entry.version)).toEqual(entry);
    expect(await snapshot()).toEqual(before);
    entry = await service.publish(entry.id, entry.version);
    const published = await snapshot();
    expect(await service.publish(entry.id, entry.version)).toEqual(entry);
    expect(await snapshot()).toEqual(published);
  });

  it("permits one create per library CAS and one concurrent write per entry CAS", async () => {
    const expectedLibraryVersion = await library();
    const creates = await Promise.allSettled(
      ["A", "B"].map((name) =>
        service.createFolder({ expectedLibraryVersion, name, parentId: null }),
      ),
    );
    expect(creates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(creates.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 412 },
    });
    const entry = (await service.list()).items[0] as FileEntry;
    const edits = await Promise.allSettled(
      ["C", "D"].map((name) =>
        service.rename(entry.id, { expectedVersion: entry.version, name }),
      ),
    );
    expect(edits.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 412 },
    });
    const current = await service.get(entry.id);
    await expect(
      service.rename(entry.id, {
        expectedVersion: entry.version,
        name: current.name,
      }),
    ).rejects.toMatchObject({ status: 412 });
  });

  it("checks a destination deleted immediately before the move transaction", async () => {
    const moving = await folder("Moving"),
      destination = await folder("Destination");
    const raced = new FilesService(
      beforeBatch(() =>
        service.softDelete(destination.id, destination.version),
      ),
      access,
    );
    await expect(
      raced.move(moving.id, {
        expectedVersion: moving.version,
        parentId: destination.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.get(moving.id)).toEqual(moving);
    expect((await service.get(destination.id)).deletedAt).not.toBeNull();
    expect((await audit()).some((event) => event.action === "file.move")).toBe(
      false,
    );
  });

  it("returns the mutation's own batch snapshot when another writer immediately follows", async () => {
    const entry = await folder();
    let followed = false;
    const wrapped = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!followed) {
              followed = true;
              await service.rename(entry.id, {
                expectedVersion: 2,
                name: "Following",
              });
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      await new FilesService(wrapped, access).rename(entry.id, {
        expectedVersion: 1,
        name: "First",
      }),
    ).toMatchObject({ name: "First", version: 2 });
    expect(await service.get(entry.id)).toMatchObject({
      name: "Following",
      version: 3,
    });
  });

  it("reconciles an already completed identical receipt without another audit", async () => {
    let entry = await prepare();
    const received = objectReceipt(
      await service.authorizeUpload(entry.id, "source", entry.version),
    );
    entry = await service.finishObject(received, entry.version);
    const before = await snapshot();
    const descriptor = await service.authorizeUpload(
      entry.id,
      "source",
      entry.version,
    );
    expect(descriptor.entryVersion).toBe(entry.version);
    const reordered = Object.fromEntries(
      Object.entries(received).reverse(),
    ) as unknown as ObjectReceipt;
    expect(await service.finishObject(reordered, entry.version)).toEqual(entry);
    expect(await snapshot()).toEqual(before);
    await expect(
      service.finishObject(
        { ...received, r2Version: "another-object-version" },
        entry.version,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects mismatched or unbounded receipt data without partial D1 writes", async () => {
    const entry = await prepare();
    const received = objectReceipt(
      await service.authorizeUpload(entry.id, "source", entry.version),
    );
    const before = await snapshot();
    for (const override of [
      { objectId: crypto.randomUUID() },
      { receiptToken: "0".repeat(64) },
      { objectKey: "other" },
      { bytes: received.bytes + 1 },
      { sha256: "b".repeat(64) },
      { mime: "image/svg+xml" },
      { mime: "image/jpeg" },
      { mime: "application/octet-stream", width: null, height: null },
      { width: 50_000, height: 50_000 },
      { width: null },
      { width: 1.5 },
      { r2Version: "" },
    ])
      await expect(
        service.finishObject(
          { ...received, ...override } as ObjectReceipt,
          entry.version,
        ),
      ).rejects.toBeDefined();
    expect(await snapshot()).toEqual(before);
  });

  it("rejects partial receipt fields in SQL rather than accepting a nullable CHECK", async () => {
    const entry = await prepare();
    const before = await snapshot();
    await expect(
      env.DB.prepare(
        "UPDATE file_objects SET verified_at=?,r2_version='incomplete' WHERE file_id=? AND role='source'",
      )
        .bind(new Date().toISOString(), entry.id)
        .run(),
    ).rejects.toThrow(/CHECK/);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps completed receipts immutable and reconciles the same receipt after publication", async () => {
    let entry = await finish(await prepare());
    const received = (await service.getStoredObject(entry.id, "source"))
      .receipt;
    entry = await service.publish(entry.id, entry.version);
    const before = await snapshot();
    expect(
      (await service.authorizeUpload(entry.id, "source", entry.version))
        .entryVersion,
    ).toBe(entry.version);
    expect(await service.finishObject(received, entry.version)).toEqual(entry);
    await expect(
      env.DB.prepare(
        "UPDATE file_objects SET r2_version='replacement' WHERE file_id=?",
      )
        .bind(entry.id)
        .run(),
    ).rejects.toThrow("files_immutable");
    expect(await snapshot()).toEqual(before);
  });

  it("lets only one concurrent source finalize win without leaking another receipt or audit", async () => {
    const entry = await prepare();
    const received = objectReceipt(
      await service.authorizeUpload(entry.id, "source", entry.version),
    );
    const outcomes = await Promise.allSettled([
      service.finishObject(received, entry.version),
      service.finishObject(received, entry.version),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { status: 412 } });
    expect((await service.get(entry.id)).version).toBe(2);
    expect((await audit()).map((event) => event.action)).toEqual([
      "file.prepare",
      "file.finalize",
    ]);
  });

  it("expires unfinished uploads but allows the current administrator to cancel them", async () => {
    const entry = await prepare();
    const received = objectReceipt(
      await service.authorizeUpload(entry.id, "source", entry.version),
    );
    await env.DB.exec("DROP TRIGGER file_entries_update_guard;");
    await env.DB.prepare(
      "UPDATE file_entries SET upload_expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(entry.id)
      .run();
    await expect(
      service.authorizeUpload(entry.id, "source", entry.version),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.finishObject(received, entry.version),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.abandon(entry.id, entry.version)).state).toBe(
      "abandoned",
    );
  });

  it("password rotation blocks an old pending upload but permits cancellation and existing-ready reads", async () => {
    const pending = await prepare("Pending.png");
    const received = objectReceipt(
      await service.authorizeUpload(pending.id, "source", pending.version),
    );
    const ready = await finish(await prepare("Ready.png"));
    await env.DB.prepare(
      "UPDATE administrators SET auth_version=auth_version+1 WHERE id=1",
    ).run();
    access = await seedContentAccess(env.DB);
    service = new FilesService(env.DB, access);
    await expect(
      service.authorizeUpload(pending.id, "source", pending.version),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.finishObject(received, pending.version),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.abandon(pending.id, pending.version)).state).toBe(
      "abandoned",
    );
    expect((await service.getStoredObject(ready.id, "source")).entry.id).toBe(
      ready.id,
    );
  });

  it.each(["logout", "credentials", "absolute", "idle"] as const)(
    "rejects private reads and writes after %s",
    async (kind) => {
      const entry = await folder();
      if (kind === "logout")
        await env.DB.prepare("DELETE FROM admin_sessions").run();
      else if (kind === "credentials")
        await env.DB.prepare(
          "UPDATE administrators SET auth_version=auth_version+1 WHERE id=1",
        ).run();
      else
        await env.DB.prepare(
          "UPDATE admin_sessions SET created_at=?,expires_at=?,last_seen_at=?",
        )
          .bind(
            Date.now() - AUTH_LIMITS.absoluteMs - 2000,
            kind === "absolute" ? Date.now() - 1000 : Date.now() + 60_000,
            kind === "idle"
              ? Date.now() - AUTH_LIMITS.idleMs - 1000
              : Date.now() - 1000,
          )
          .run();
      await expect(service.list()).rejects.toMatchObject({ status: 401 });
      await expect(service.get(entry.id)).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        service.rename(entry.id, {
          expectedVersion: entry.version,
          name: "Changed",
        }),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it.each(["create", "rename", "noop", "finish"] as const)(
    "leaves no side effects when logout wins before %s batch",
    async (kind) => {
      const folderEntry = await folder();
      const upload = await prepare();
      const received = objectReceipt(
        await service.authorizeUpload(upload.id, "source", upload.version),
      );
      const expectedLibraryVersion = await library(),
        before = await snapshot();
      const raced = new FilesService(
        beforeBatch(() => env.DB.prepare("DELETE FROM admin_sessions").run()),
        access,
      );
      const request =
        kind === "create"
          ? raced.createFolder({
              expectedLibraryVersion,
              name: "Raced",
              parentId: null,
            })
          : kind === "finish"
            ? raced.finishObject(received, upload.version)
            : raced.rename(folderEntry.id, {
                expectedVersion: folderEntry.version,
                name: kind === "noop" ? folderEntry.name : "Raced",
              });
      await expect(request).rejects.toMatchObject({ status: 401 });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("rolls back receipt, entry, library and audit together if audit insertion fails", async () => {
    const entry = await prepare();
    const received = objectReceipt(
      await service.authorizeUpload(entry.id, "source", entry.version),
    );
    const before = await snapshot();
    await env.DB.exec(
      "CREATE TRIGGER files_fixture_failure BEFORE INSERT ON audit_records WHEN NEW.category='file' BEGIN SELECT RAISE(ABORT,'private_audit_canary'); END;",
    );
    await expect(
      service.finishObject(received, entry.version),
    ).rejects.toMatchObject({
      status: 503,
      message: "File storage is temporarily unavailable.",
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe("file queries and validation", () => {
  it("uses scoped UTF-8 cursors and invalidates them after a library change", async () => {
    for (const name of ["文档甲", "文档乙", "文档丙"]) await folder(name);
    const first = await service.list({ q: "文档", limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const next = await service.list({
      q: "文档",
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
    await expect(
      service.list({ q: "other", cursor: first.nextCursor as string }),
    ).rejects.toMatchObject({ status: 400 });
    await folder("Other");
    await expect(
      service.list({ q: "文档", cursor: first.nextCursor as string }),
    ).rejects.toMatchObject({ status: 412 });
  });

  it("separates active folders, global trash and abandoned uploads", async () => {
    const parent = await folder();
    let child = await folder("Child", parent.id);
    child = await service.softDelete(child.id, child.version);
    const cancelled = await prepare();
    await service.abandon(cancelled.id, cancelled.version);
    expect((await service.list()).items.map((item) => item.id)).toEqual([
      parent.id,
    ]);
    expect(
      (await service.list({ state: "deleted" })).items.map((item) => item.id),
    ).toEqual([child.id]);
    expect((await service.list({ parentId: parent.id })).items).toEqual([]);
  });

  it("rejects malformed inputs and declared size/type limits before mutation", async () => {
    const before = await snapshot();
    for (const name of ["", "..", "a/b", "a\\b", "x\u0000y", "x".repeat(201)])
      await expect(folder(name)).rejects.toMatchObject({ status: 400 });
    for (const sourceOverride of [
      { bytes: 0 },
      { bytes: FILE_LIMITS.sourceBytes + 1 },
      { bytes: FILE_LIMITS.imageBytes + 1 },
      { sha256: "bad" },
      { mimeHint: "image/svg+xml" },
    ]) {
      await expect(
        service.prepareUpload({
          expectedLibraryVersion: 1,
          parentId: null,
          name: "Invalid",
          source: { ...source, ...sourceOverride } as ObjectInput,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      service.prepareUpload({
        expectedLibraryVersion: 1,
        parentId: null,
        name: "Invalid",
        source: { ...source, mimeHint: "application/octet-stream" },
        thumbnail: source,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.list({ limit: 51 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.list({ unknown: true } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it("fails closed for corrupt rows, missing library and preparation errors", async () => {
    const entry = await folder();
    await env.DB.prepare(
      "UPDATE file_entries SET name=' padded ',name_key=' padded ',version=version+1 WHERE id=?",
    )
      .bind(entry.id)
      .run();
    await expect(service.get(entry.id)).rejects.toMatchObject({ status: 503 });
    await env.DB.exec(
      "DROP TRIGGER file_library_no_delete; DELETE FROM file_library;",
    );
    await expect(service.list()).rejects.toMatchObject({ status: 503 });
    const failed = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return () => {
            throw new Error("private_sql_canary");
          };
        return Reflect.get(target, property, target);
      },
    });
    await expect(
      new FilesService(failed, access).get(entry.id),
    ).rejects.toMatchObject({
      status: 503,
      message: "File storage is temporarily unavailable.",
    });
    await expect(
      getPublicFileObject(failed, entry.id, "source"),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("preserves old settings rows and audit writers across the additive migration", async () => {
    await reset();
    const index = migrations.findIndex(
      (migration) => migration.name === "0010_files.sql",
    );
    await applyD1Migrations(env.DB, migrations.slice(0, index));
    access = await seedContentAccess(env.DB);
    const settings = new SettingsService(env.DB, access);
    const old = await settings.get();
    const before = (
      await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all()
    ).results;
    await applyD1Migrations(env.DB, migrations);
    expect(await settings.get()).toEqual(old);
    expect(
      (await env.DB.prepare("SELECT * FROM audit_records ORDER BY seq").all())
        .results,
    ).toEqual(before);
    const { version: expectedVersion, updatedAt: _updatedAt, ...values } = old;
    await settings.update({ ...values, expectedVersion, theme: "dark" });
    expect(
      (
        await env.DB.prepare(
          "SELECT action FROM audit_records ORDER BY seq DESC LIMIT 1",
        ).first()
      )?.action,
    ).toBe("settings.update");
    const initial = (await env.DB.prepare("SELECT * FROM file_library").all())
      .results;
    await applyD1Migrations(env.DB, migrations);
    expect(
      (await env.DB.prepare("SELECT * FROM file_library").all()).results,
    ).toEqual(initial);
  });
});
