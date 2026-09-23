import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { FileEntry, FilePage } from "../shared/files";
import { sha256 } from "../worker/auth/crypto";
import { FilesError } from "../worker/files/contracts";
import { FilesService } from "../worker/files/service";
import { serveFile } from "../worker/files-http";
import {
  fixtureAccess,
  fixtureSessionToken,
  seedContentAccess,
} from "./content-fixture";

const origin = "https://example.com";
const cookie = `__Host-wiki_session=${fixtureSessionToken}`;
let headers: Record<string, string>;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  await seedContentAccess(env.DB);
  headers = {
    Cookie: cookie,
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": await sha256(`csrf:${fixtureSessionToken}`),
  };
});
function api(path = "", method = "GET", body?: unknown, selected = headers) {
  return exports.default.fetch(`${origin}/api/admin/files${path}`, {
    method,
    headers: selected,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function list() {
  const response = await api();
  expect(response.status).toBe(200);
  return (await response.json()) as FilePage;
}
async function bodyText(response: Response) {
  return new TextDecoder().decode(await response.arrayBuffer());
}
async function prepare(name = "配置文件.txt", text = "a safe attachment") {
  const page = await list();
  const response = await api("/uploads", "POST", {
    expectedLibraryVersion: page.libraryVersion,
    parentId: null,
    name,
    source: {
      bytes: new TextEncoder().encode(text).length,
      sha256: await sha256(text),
      mimeHint: "application/octet-stream",
    },
  });
  expect(response.status).toBe(201);
  const entry = (await response.json()) as FileEntry;
  return { entry, text };
}
function upload(
  entry: FileEntry,
  text: string,
  selected: Record<string, string> = {},
) {
  return exports.default.fetch(
    `${origin}/api/admin/files/${entry.id}/upload/source`,
    {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-File-Version": String(entry.version),
        ...selected,
      },
      body: text,
    },
  );
}
async function ready(name?: string, text?: string) {
  const prepared = await prepare(name, text);
  const response = await upload(prepared.entry, prepared.text);
  expect(response.status).toBe(200);
  return (await response.json()) as FileEntry;
}
async function mutate(
  entry: FileEntry,
  action: string,
  body: Record<string, unknown> = {},
) {
  const response = await api(`/${entry.id}/${action}`, "POST", {
    expectedVersion: entry.version,
    ...body,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as FileEntry;
}

describe("file HTTP authorization and lifecycle", () => {
  it("authenticates before dispatch, queries or methods", async () => {
    for (const path of ["", "?unknown=x", "/uploads", "/unknown/upload/source"])
      for (const method of ["GET", "PUT", "POST", "DELETE"])
        for (const Cookie of [
          "",
          `${cookie}; ${cookie}`,
          "__Host-wiki_session=invalid",
        ]) {
          const response = await api(path, method, undefined, { Cookie });
          expect(response.status).toBe(401);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(
            response.headers.get("Access-Control-Allow-Origin"),
          ).toBeNull();
        }
  });

  it("requires exact Origin and CSRF for creation and raw upload", async () => {
    const body = {
      expectedLibraryVersion: (await list()).libraryVersion,
      parentId: null,
      name: "folder",
    };
    for (const selected of [
      { ...headers, Origin: "https://outside.example" },
      { ...headers, "X-CSRF-Token": "invalid" },
      { ...headers, "Sec-Fetch-Site": "cross-site" },
    ]) {
      expect((await api("/folders", "POST", body, selected)).status).toBe(403);
    }
    expect((await list()).items).toEqual([]);
    const { entry, text } = await prepare();
    const invalidUploadHeaders: Record<string, string>[] = [
      { Origin: "https://outside.example" },
      { "X-CSRF-Token": "invalid" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const selected of invalidUploadHeaders)
      expect((await upload(entry, text, selected)).status).toBe(403);
    expect((await env.MEDIA.list()).objects).toEqual([]);
  });

  it("keeps pending and ready uploads private and never exposes transfer descriptors", async () => {
    const { entry, text } = await prepare();
    const path = `${origin}/files/${entry.id}/download`;
    expect((await exports.default.fetch(path)).status).toBe(404);
    expect((await api(`/${entry.id}/download`)).status).toBe(404);
    const uploaded = await upload(entry, text);
    expect(uploaded.status).toBe(200);
    const current = (await uploaded.json()) as FileEntry;
    expect(current.state).toBe("ready");
    expect(current.publishedAt).toBeNull();
    for (const result of [entry, current, await list()])
      expect(JSON.stringify(result)).not.toMatch(
        /objectKey|objectId|receiptToken|sha256|uploadAuthVersion|r2Version/,
      );
    expect((await exports.default.fetch(path)).status).toBe(404);
    const download = await api(`/${entry.id}/download`);
    expect(download.status).toBe(200);
    expect(await bodyText(download)).toBe(text);
    expect(download.headers.get("Vary")).toContain("Cookie");
    expect((await api(`/${entry.id}/image`)).status).toBe(404);
    const objects = await env.MEDIA.list();
    expect(objects.objects).toHaveLength(1);
    const reconciliation = await api(`/${entry.id}/reconcile/source`, "POST", {
      expectedVersion: current.version,
    });
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toEqual(current);
    expect((await env.MEDIA.list()).objects).toHaveLength(1);
  });

  it("serves public attachments safely with HEAD, ranges, conditions and immediate withdrawal", async () => {
    const text = "<!doctype html><script>alert(1)</script>";
    let entry = await ready("中文附件.html", text);
    entry = await mutate(entry, "publish");
    const path = `${origin}/files/${entry.id}/download`;
    const response = await exports.default.fetch(path);
    expect(response.status).toBe(200);
    expect(await bodyText(response)).toBe(text);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toContain(
      "attachment;",
    );
    expect(response.headers.get("Content-Disposition")).toContain(
      "filename*=UTF-8''%E4%B8%AD",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const etag = response.headers.get("ETag") as string;
    const head = await exports.default.fetch(path, {
      method: "HEAD",
      headers: { Range: "bytes=0-1" },
    });
    expect(head.status).toBe(200);
    expect(await bodyText(head)).toBe("");
    expect(head.headers.get("Content-Length")).toBe(String(text.length));
    const partial = await exports.default.fetch(path, {
      headers: { Range: "bytes=1-4" },
    });
    expect(partial.status).toBe(206);
    expect(await bodyText(partial)).toBe(text.slice(1, 5));
    expect(partial.headers.get("Content-Range")).toBe(
      `bytes 1-4/${text.length}`,
    );
    const suffix = await exports.default.fetch(path, {
      headers: { Range: "bytes=-3" },
    });
    expect(suffix.status).toBe(206);
    expect(await bodyText(suffix)).toBe(text.slice(-3));
    const invalid = await exports.default.fetch(path, {
      headers: { Range: "bytes=0-1,4-5" },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe(`bytes */${text.length}`);
    expect(
      (
        await exports.default.fetch(path, {
          headers: { "If-None-Match": etag },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await exports.default.fetch(path, {
          headers: { Range: "bytes=0-1", "If-Range": '"old"' },
        })
      ).status,
    ).toBe(200);
    entry = await mutate(entry, "unpublish");
    for (const method of ["GET", "HEAD"])
      expect(
        (
          await exports.default.fetch(path, {
            method,
            headers: { "If-None-Match": etag, Range: "bytes=0-1" },
          })
        ).status,
      ).toBe(404);
    entry = await mutate(entry, "delete");
    entry = await mutate(entry, "restore", { parentId: null });
    expect(entry.publishedAt).toBeNull();
    expect((await exports.default.fetch(path)).status).toBe(404);
  });

  it("preserves public identity across rename and rejects stale writes", async () => {
    let entry = await ready();
    const original = entry;
    const folderResponse = await api("/folders", "POST", {
      expectedLibraryVersion: (await list()).libraryVersion,
      parentId: null,
      name: "文件夹",
    });
    expect(folderResponse.status).toBe(201);
    const folder = (await folderResponse.json()) as FileEntry;
    entry = await mutate(entry, "publish");
    entry = await mutate(entry, "rename", { name: "renamed.txt" });
    entry = await mutate(entry, "move", { parentId: folder.id });
    expect(entry.id).toBe(original.id);
    const nested = await api(`?parentId=${folder.id}`);
    expect(
      ((await nested.json()) as FilePage).items.map((item) => item.id),
    ).toEqual([entry.id]);
    expect(
      (await exports.default.fetch(`${origin}/files/${entry.id}/download`))
        .status,
    ).toBe(200);
    expect(
      (
        await api(`/${entry.id}/rename`, "POST", {
          expectedVersion: original.version,
          name: "stale.txt",
        })
      ).status,
    ).toBe(412);
  });

  it("serves only verified raster types inline after explicit publication", async () => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ioAAAAASUVORK5CYII=",
      ),
      (value) => value.charCodeAt(0),
    );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    const prepared = await api("/uploads", "POST", {
      expectedLibraryVersion: (await list()).libraryVersion,
      parentId: null,
      name: "截图.png",
      source: { bytes: bytes.length, sha256: digest, mimeHint: "image/png" },
    });
    expect(prepared.status).toBe(201);
    let entry = (await prepared.json()) as FileEntry;
    const uploaded = await exports.default.fetch(
      `${origin}/api/admin/files/${entry.id}/upload/source`,
      {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "X-File-Version": String(entry.version),
        },
        body: bytes,
      },
    );
    expect(uploaded.status).toBe(200);
    entry = (await uploaded.json()) as FileEntry;
    expect(entry.source).toEqual({
      bytes: bytes.length,
      mime: "image/png",
      width: 1,
      height: 1,
    });
    const path = `${origin}/files/${entry.id}/image`;
    expect((await exports.default.fetch(path)).status).toBe(404);
    const preview = await api(`/${entry.id}/image`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);
    entry = await mutate(entry, "publish");
    const image = await exports.default.fetch(path);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Disposition")).toContain("inline;");
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    expect(
      (await exports.default.fetch(`${origin}/files/${entry.id}/thumbnail`))
        .status,
    ).toBe(404);
  });

  it("does not recreate a completed object that disappeared outside the file service", async () => {
    const entry = await ready();
    const stored = (await env.MEDIA.list()).objects;
    expect(stored).toHaveLength(1);
    const object = stored[0];
    if (!object) throw new Error("Expected a stored fixture object");
    await env.MEDIA.delete(object.key);
    expect((await upload(entry, "a safe attachment")).status).toBe(409);
    expect((await env.MEDIA.list()).objects).toEqual([]);
  });

  it("rechecks access after R2 for body, HEAD, 304 and unsatisfiable range responses", async () => {
    const entry = await ready();
    const service = new FilesService(env.DB, fixtureAccess);
    const stored = await service.getStoredObject(entry.id, "source");
    const variants: RequestInit[] = [
      {},
      { method: "HEAD" },
      { headers: { "If-None-Match": `"${entry.id}-source-${entry.version}"` } },
      { headers: { Range: "bytes=999999-" } },
    ];
    for (const init of variants) {
      let reads = 0;
      await expect(
        serveFile(
          new Request(`${origin}/files/${entry.id}/download`, init),
          env.MEDIA,
          async () => (++reads === 1 ? stored : null),
          "download",
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(reads).toBe(2);
    }
    let reads = 0;
    await expect(
      serveFile(
        new Request(`${origin}/api/admin/files/${entry.id}/download`),
        env.MEDIA,
        async () => {
          if (++reads > 1)
            throw new FilesError(401, "Authentication required.");
          return stored;
        },
        "download",
        true,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("bounds queries/JSON and validates upload headers before writing R2", async () => {
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?q=a&q=b",
      "?state=unknown",
      "?unexpected=1",
      "?parentId=../outside",
    ])
      expect((await api(query)).status).toBe(400);
    expect(
      (await api("/folders", "POST", { name: "x".repeat(5000) })).status,
    ).toBe(400);
    const { entry, text } = await prepare();
    for (const value of ["", "0", "1,1", "-1", "9007199254740992"])
      expect(
        (await upload(entry, text, { "X-File-Version": value })).status,
      ).toBe(400);
    expect(
      (await upload(entry, text, { "Content-Type": "text/plain" })).status,
    ).toBe(415);
    expect(
      (await upload(entry, text, { "Content-Encoding": "gzip" })).status,
    ).toBe(415);
    expect((await api(`/${entry.id}/upload/source`, "POST")).status).toBe(405);
    expect((await api(`/${entry.id}/upload/unknown`, "PUT")).status).toBe(404);
    expect((await env.MEDIA.list()).objects).toEqual([]);
  });
});
