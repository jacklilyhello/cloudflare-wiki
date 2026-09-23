import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { FileMime } from "../shared/files";
import type { UploadDescriptor } from "../worker/files/contracts";
import { inspectImagePrefix } from "../worker/files/image";
import {
  getStoredObject,
  headStoredObject,
  putPreparedObject,
  reconcilePreparedObject,
  verifyStoredObject,
} from "../worker/files/transfer";

const encoder = new TextEncoder();
const canary = "upstream-storage-secret-not-for-output";
async function descriptor(
  bytes: Uint8Array,
  mimeHint: FileMime = "application/octet-stream",
  overrides: Partial<UploadDescriptor> = {},
): Promise<UploadDescriptor> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const fileId = crypto.randomUUID();
  const objectId = crypto.randomUUID();
  return {
    fileId,
    objectId,
    objectKey: `files/${fileId}/${objectId}`,
    role: "source",
    receiptToken: "a".repeat(64),
    expectedBytes: bytes.length,
    expectedSha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    mimeHint,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    uploadAuthVersion: 1,
    entryVersion: 1,
    ...overrides,
  };
}
function stream(chunks: Uint8Array[], cancel = vi.fn()) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
}
function bucket(overrides: Record<string, unknown>): R2Bucket {
  return new Proxy(env.MEDIA, {
    get(target, key) {
      if (typeof key === "string" && key in overrides) return overrides[key];
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
function png(width = 1, height = 1) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(encoder.encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}
function jpeg(width = 2, height = 3) {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
    0xff,
    0xd9,
  ]);
}
function webp(width = 2, height = 3, kind: "VP8X" | "VP8L" | "VP8 " = "VP8X") {
  const bytes = new Uint8Array(kind === "VP8L" ? 26 : 30);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("RIFF"));
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(encoder.encode(`WEBP${kind}`), 8);
  view.setUint32(16, kind === "VP8L" ? 5 : 10, true);
  if (kind === "VP8X") {
    const w = width - 1;
    const h = height - 1;
    bytes.set(
      [w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16],
      24,
    );
  } else if (kind === "VP8L") {
    bytes[20] = 0x2f;
    view.setUint32(21, (width - 1) | ((height - 1) << 14), true);
  } else {
    bytes.set([0x9d, 1, 0x2a], 23);
    view.setUint16(26, width, true);
    view.setUint16(28, height, true);
  }
  return bytes;
}

describe("R2 upload and receipts", () => {
  it("streams an octet source with a verified R2 SHA-256 and server receipt", async () => {
    const bytes = encoder.encode("hello private file");
    const prepared = await descriptor(bytes);
    const receipt = await putPreparedObject(
      env.MEDIA,
      prepared,
      stream([bytes.subarray(0, 3), bytes.subarray(3)]),
    );
    expect(receipt).toMatchObject({
      fileId: prepared.fileId,
      bytes: bytes.length,
      sha256: prepared.expectedSha256,
      mime: "application/octet-stream",
      width: null,
      height: null,
    });
    const stored = await getStoredObject(env.MEDIA, prepared, receipt);
    expect(await stored?.text()).toBe("hello private file");
    expect(await reconcilePreparedObject(env.MEDIA, prepared)).toEqual(receipt);
  });

  it("does not overwrite an existing object or automatically reconcile a collision", async () => {
    const bytes = encoder.encode("original");
    const prepared = await descriptor(bytes);
    await putPreparedObject(env.MEDIA, prepared, stream([bytes]));
    const head = vi.fn();
    const spy = bucket({ head });
    await expect(
      putPreparedObject(spy, prepared, stream([bytes])),
    ).rejects.toMatchObject({ status: 409 });
    expect(head).not.toHaveBeenCalled();
    expect(await (await env.MEDIA.get(prepared.objectKey))?.text()).toBe(
      "original",
    );
  });

  it("settles an immediate conditional rejection without a waiting consumer", async () => {
    const bytes = new Uint8Array(256 * 1024);
    const prepared = await descriptor(bytes);
    const cancel = vi.fn();
    const put = vi.fn(async () => null);
    await expect(
      putPreparedObject(bucket({ put }), prepared, stream([bytes], cancel)),
    ).rejects.toMatchObject({ status: 409 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
  }, 2000);

  it("settles an immediate storage rejection and hides its response details", async () => {
    const bytes = new Uint8Array(256 * 1024);
    const prepared = await descriptor(bytes);
    const put = vi.fn(async () => {
      throw new Error(canary);
    });
    await expect(
      putPreparedObject(bucket({ put }), prepared, stream([bytes])),
    ).rejects.toMatchObject({ status: 503 });
    expect(put).toHaveBeenCalledTimes(1);
  }, 2000);
});

describe("bounded header inspection", () => {
  it.each([
    ["image/png", png()],
    ["image/jpeg", jpeg()],
    ["image/webp", webp()],
    ["image/webp", webp(2, 3, "VP8L")],
    ["image/webp", webp(2, 3, "VP8 ")],
  ] as const)(
    "inspects %s headers across streamed input",
    async (mime, bytes) => {
      const prepared = await descriptor(bytes, mime);
      const receipt = await putPreparedObject(
        env.MEDIA,
        prepared,
        stream(Array.from(bytes, (byte) => new Uint8Array([byte]))),
      );
      expect(receipt.mime).toBe(mime);
      expect(receipt.width).toBe(mime === "image/png" ? 1 : 2);
      expect(receipt.height).toBe(mime === "image/png" ? 1 : 3);
    },
  );
  it("keeps unknown sources as downloads despite image signatures", () => {
    expect(
      inspectImagePrefix(png(), "application/octet-stream", 33, "source"),
    ).toEqual({ mime: "application/octet-stream", width: null, height: null });
  });
});

describe("exact-length streams and cancellation", () => {
  it.each(["short", "extra", "late stream error"])(
    "never commits a %s body",
    async (mode) => {
      const bytes = new Uint8Array(192 * 1024);
      const prepared = await descriptor(bytes);
      let sent = false;
      const body =
        mode === "late stream error"
          ? new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sent) {
                  sent = true;
                  controller.enqueue(bytes);
                } else controller.error(new Error(canary));
              },
            })
          : stream(
              mode === "short"
                ? [bytes.subarray(0, bytes.length - 1)]
                : [bytes, new Uint8Array([1])],
            );
      await expect(
        putPreparedObject(env.MEDIA, prepared, body),
      ).rejects.toMatchObject({ status: 400 });
      expect(await env.MEDIA.head(prepared.objectKey)).toBeNull();
    },
    2000,
  );

  it("does not release the final chunk before the source confirms EOF", async () => {
    const bytes = new Uint8Array(192 * 1024);
    const prepared = await descriptor(bytes);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(bytes);
      },
    });
    let consumed = 0;
    let committed = false;
    let ready: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const put = vi.fn(
      async (_key: string, value: ReadableStream<Uint8Array>) => {
        const reader = value.getReader();
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            consumed += chunk.length;
            if (consumed === bytes.length - 64 * 1024) ready?.();
          }
          committed = true;
          throw new Error("synthetic storage result");
        } finally {
          reader.releaseLock();
        }
      },
    );
    const pending = putPreparedObject(bucket({ put }), prepared, body);
    const outcome = pending.catch((error: unknown) => error);
    await observed;
    expect(consumed).toBe(bytes.length - 64 * 1024);
    expect(committed).toBe(false);
    controller?.enqueue(new Uint8Array([1]));
    controller?.close();
    expect(await outcome).toMatchObject({ status: 400 });
    expect(committed).toBe(false);
  }, 2000);

  it("aborts before upload without invoking R2", async () => {
    const bytes = encoder.encode("data");
    const prepared = await descriptor(bytes);
    const abort = new AbortController();
    abort.abort();
    const put = vi.fn();
    const cancel = vi.fn();
    await expect(
      putPreparedObject(
        bucket({ put }),
        prepared,
        stream([bytes], cancel),
        abort.signal,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(put).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("settles abort while the source is waiting for more bytes", async () => {
    const bytes = new Uint8Array(192 * 1024);
    const prepared = await descriptor(bytes);
    const abort = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 128 * 1024));
      },
      cancel,
    });
    const put = async (
      key: string,
      value: ReadableStream,
      options: R2PutOptions,
    ) => {
      const pending = env.MEDIA.put(key, value, options);
      queueMicrotask(() => abort.abort());
      return pending;
    };
    await expect(
      putPreparedObject(bucket({ put }), prepared, body, abort.signal),
    ).rejects.toMatchObject({ status: 400 });
    expect(cancel).toHaveBeenCalled();
    expect(await env.MEDIA.head(prepared.objectKey)).toBeNull();
  }, 2000);

  it("checks the expected SHA-256 through R2 without treating ETag as a digest", async () => {
    const bytes = encoder.encode("checksum mismatch");
    const prepared = await descriptor(bytes, "application/octet-stream", {
      expectedSha256: "0".repeat(64),
    });
    await expect(
      putPreparedObject(env.MEDIA, prepared, stream([bytes])),
    ).rejects.toMatchObject({ status: 503 });
    expect(await env.MEDIA.head(prepared.objectKey)).toBeNull();
  });

  it("requires a real raw body and rejects a locked stream", async () => {
    const prepared = await descriptor(encoder.encode("test"));
    const put = vi.fn();
    await expect(
      putPreparedObject(bucket({ put }), prepared, null),
    ).rejects.toMatchObject({ status: 400 });
    const body = stream([encoder.encode("test")]);
    const reader = body.getReader();
    await expect(
      putPreparedObject(bucket({ put }), prepared, body),
    ).rejects.toMatchObject({ status: 400 });
    reader.releaseLock();
    expect(put).not.toHaveBeenCalled();
  });
});

describe("format and size limits", () => {
  it.each([
    ["mismatched type", png(), "image/jpeg", 415],
    ["zero dimensions", png(0, 1), "image/png", 415],
    ["excessive pixels", png(5001, 5000), "image/png", 413],
    [
      "JPEG marker forgery",
      new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]),
      "image/jpeg",
      415,
    ],
    ["truncated header", new Uint8Array([137, 80, 78]), "image/png", 415],
    [
      "SVG source",
      encoder.encode("<svg onload='alert(1)'></svg>"),
      "image/png",
      415,
    ],
  ] as const)(
    "rejects %s before any PUT",
    async (_label, bytes, mime, status) => {
      const prepared = await descriptor(bytes, mime);
      const put = vi.fn();
      await expect(
        putPreparedObject(bucket({ put }), prepared, stream([bytes])),
      ).rejects.toMatchObject({ status });
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("rejects corrupted PNG CRC and format fields", () => {
    for (const index of [8, 12, 24, 25, 26, 27, 28, 29]) {
      const bytes = png();
      bytes[index] = 255;
      expect(() =>
        inspectImagePrefix(bytes, "image/png", bytes.length, "source"),
      ).toThrow();
    }
  });

  it("rejects inconsistent WebP length, signature, reserved bits and frame headers", () => {
    for (const [kind, index] of [
      ["VP8X", 4],
      ["VP8X", 8],
      ["VP8X", 20],
      ["VP8L", 20],
      ["VP8L", 24],
      ["VP8 ", 23],
    ] as const) {
      const bytes = webp(2, 3, kind);
      bytes[index] = 255;
      expect(() =>
        inspectImagePrefix(bytes, "image/webp", bytes.length, "source"),
      ).toThrow();
    }
  });

  it("rejects an image header beyond the fixed 1 MiB inspection prefix", async () => {
    const segment = new Uint8Array(65_537);
    segment.set([0xff, 0xe1, 0xff, 0xff]);
    const bytes = new Uint8Array(2 + segment.length * 17 + jpeg().length - 2);
    bytes.set([0xff, 0xd8]);
    for (let index = 0; index < 17; index++)
      bytes.set(segment, 2 + index * segment.length);
    bytes.set(jpeg().subarray(2), 2 + 17 * segment.length);
    const prepared = await descriptor(bytes, "image/jpeg");
    const put = vi.fn();
    const cancel = vi.fn();
    await expect(
      putPreparedObject(bucket({ put }), prepared, stream([bytes], cancel)),
    ).rejects.toMatchObject({ status: 415 });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ["source", "application/octet-stream", 20 * 1024 * 1024 + 1],
    ["source", "image/png", 10 * 1024 * 1024 + 1],
    ["thumbnail", "image/png", 256 * 1024 + 1],
  ] as const)(
    "rejects oversize %s %s before consuming input",
    async (role, mimeHint, expectedBytes) => {
      const prepared = await descriptor(png(), mimeHint, {
        role,
        expectedBytes,
      });
      const put = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull });
      await expect(
        putPreparedObject(bucket({ put }), prepared, body),
      ).rejects.toMatchObject({ status: 413 });
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("accepts a 320px thumbnail and rejects larger or octet thumbnails", async () => {
    const bytes = png(320, 320);
    const prepared = await descriptor(bytes, "image/png", {
      role: "thumbnail",
    });
    expect(
      await putPreparedObject(env.MEDIA, prepared, stream([bytes])),
    ).toMatchObject({ width: 320, height: 320, role: "thumbnail" });
    const tooWide = png(321, 1);
    const put = vi.fn();
    await expect(
      putPreparedObject(
        bucket({ put }),
        await descriptor(tooWide, "image/png", { role: "thumbnail" }),
        stream([tooWide]),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      putPreparedObject(
        bucket({ put }),
        await descriptor(bytes, "application/octet-stream", {
          role: "thumbnail",
        }),
        stream([bytes]),
      ),
    ).rejects.toMatchObject({ status: 415 });
    expect(put).not.toHaveBeenCalled();
  });
});

describe("immutable receipt readback and serving", () => {
  it("rejects cancellation during HEAD without discarding the stored object", async () => {
    const bytes = encoder.encode("uploaded before cancellation");
    const prepared = await descriptor(bytes);
    const abort = new AbortController();
    const head = vi.fn(async (key: string) => {
      const object = await env.MEDIA.head(key);
      abort.abort();
      return object;
    });
    await expect(
      putPreparedObject(
        bucket({ head }),
        prepared,
        stream([bytes]),
        abort.signal,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(head).toHaveBeenCalledTimes(1);
    expect(await reconcilePreparedObject(env.MEDIA, prepared)).toMatchObject({
      bytes: bytes.length,
    });
  });

  it("pumps a 20 MiB source in bounded chunks without collecting the file", async () => {
    const expectedBytes = 20 * 1024 * 1024;
    const prepared = await descriptor(
      new Uint8Array([0]),
      "application/octet-stream",
      { expectedBytes, expectedSha256: "0".repeat(64) },
    );
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === expectedBytes) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(
          Math.min(127 * 1024, expectedBytes - produced),
        );
        produced += chunk.length;
        controller.enqueue(chunk);
      },
    });
    let object: R2Object | null = null;
    let consumed = 0;
    let largest = 0;
    const put = vi.fn(
      async (
        key: string,
        value: ReadableStream<Uint8Array>,
        options: R2PutOptions,
      ) => {
        expect(options.onlyIf).toBeInstanceOf(Headers);
        expect((options.onlyIf as Headers).get("If-None-Match")).toBe("*");
        expect(options.sha256).toBeInstanceOf(Uint8Array);
        expect((options.sha256 as Uint8Array).byteLength).toBe(32);
        expect(options.customMetadata).not.toHaveProperty("entryVersion");
        expect(options.customMetadata).not.toHaveProperty("uploadAuthVersion");
        const reader = value.getReader();
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            consumed += result.value.byteLength;
            largest = Math.max(largest, result.value.byteLength);
          }
        } finally {
          reader.releaseLock();
        }
        object = {
          key,
          size: consumed,
          version: "test-version",
          customMetadata: options.customMetadata,
          httpMetadata: options.httpMetadata,
          checksums: { sha256: new ArrayBuffer(32) },
        } as R2Object;
        return object;
      },
    );
    const receipt = await putPreparedObject(
      bucket({ put, head: async () => object }),
      prepared,
      body,
    );
    expect(receipt.bytes).toBe(expectedBytes);
    expect(consumed).toBe(expectedBytes);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("leaves a successful R2 object private and reconcilable after HEAD fails", async () => {
    const bytes = encoder.encode("private pending object");
    const prepared = await descriptor(bytes);
    const head = vi.fn(async () => {
      throw new Error(canary);
    });
    await expect(
      putPreparedObject(bucket({ head }), prepared, stream([bytes])),
    ).rejects.toMatchObject({ status: 503 });
    expect(head).toHaveBeenCalledTimes(1);
    expect(await reconcilePreparedObject(env.MEDIA, prepared)).toMatchObject({
      bytes: bytes.length,
      objectKey: prepared.objectKey,
    });
  });

  it("requires a completed object for explicit reconciliation", async () => {
    const prepared = await descriptor(encoder.encode("missing"));
    await expect(
      reconcilePreparedObject(env.MEDIA, prepared),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("serves verified ranges and HEAD without enforcing expired upload authorization", async () => {
    const bytes = encoder.encode("0123456789");
    const prepared = await descriptor(bytes);
    const receipt = await putPreparedObject(
      env.MEDIA,
      prepared,
      stream([bytes]),
    );
    const expired = {
      ...prepared,
      expiresAt: "2000-01-01T00:00:00.000Z",
      uploadAuthVersion: 9,
      entryVersion: 50,
    };
    expect((await headStoredObject(env.MEDIA, expired, receipt))?.size).toBe(
      10,
    );
    const ranged = await getStoredObject(env.MEDIA, expired, receipt, {
      offset: 2,
      length: 3,
    });
    expect(await ranged?.text()).toBe("234");
    expect(ranged?.range).toMatchObject({ offset: 2, length: 3 });
  });

  it("rejects altered server metadata, checksum, content type, identity and version", async () => {
    const bytes = png();
    const prepared = await descriptor(bytes, "image/png");
    const receipt = await putPreparedObject(
      env.MEDIA,
      prepared,
      stream([bytes]),
    );
    const original = await env.MEDIA.head(prepared.objectKey);
    if (!original) throw new Error("Missing test object");
    for (const changed of [
      { key: "other" },
      { size: bytes.length + 1 },
      { version: "other-version" },
      { checksums: { sha256: new ArrayBuffer(32) } },
      { checksums: {} },
      { httpMetadata: { contentType: "text/html" } },
      { httpMetadata: { contentType: "image/png", contentEncoding: "gzip" } },
      {
        customMetadata: {
          ...original.customMetadata,
          receiptToken: "b".repeat(64),
        },
      },
      { customMetadata: { ...original.customMetadata, objectId: "other" } },
      { customMetadata: { ...original.customMetadata, extra: "unexpected" } },
      { customMetadata: { ...original.customMetadata, width: "2" } },
      { customMetadata: { ...original.customMetadata, height: "0" } },
      {
        customMetadata: {
          ...original.customMetadata,
          mime: "application/octet-stream",
        },
      },
    ]) {
      const object = new Proxy(original, {
        get(target, key) {
          return key in changed
            ? Reflect.get(changed, key)
            : Reflect.get(target, key, target);
        },
      });
      expect(() => verifyStoredObject(object, prepared, receipt)).toThrow();
    }
    for (const version of [
      "",
      "x".repeat(257),
      "bad\u0000version",
      "bad\u0085version",
    ]) {
      const object = new Proxy(original, {
        get(target, key) {
          return key === "version" ? version : Reflect.get(target, key, target);
        },
      });
      // Reconciliation has no D1 receipt yet, so validate the opaque version
      // independently of the expected-receipt equality check.
      expect(() => verifyStoredObject(object, prepared)).toThrow();
    }
  });

  it("cancels a fetched body when metadata cannot match the ready receipt", async () => {
    const bytes = encoder.encode("never disclose");
    const prepared = await descriptor(bytes);
    const receipt = await putPreparedObject(
      env.MEDIA,
      prepared,
      stream([bytes]),
    );
    const original = await env.MEDIA.get(prepared.objectKey);
    if (!original) throw new Error("Missing test object");
    await original.body.cancel();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const altered = new Proxy(original, {
      get(target, key) {
        if (key === "body") return body;
        if (key === "version") return "unexpected";
        return Reflect.get(target, key, target);
      },
    });
    await expect(
      getStoredObject(bucket({ get: async () => altered }), prepared, receipt),
    ).rejects.toMatchObject({ status: 503 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
