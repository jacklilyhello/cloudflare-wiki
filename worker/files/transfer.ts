import { FILE_LIMITS, FILE_MIMES } from "../../shared/files";
import {
  FilesError,
  type ObjectReceipt,
  type UploadDescriptor,
} from "./contracts";
import {
  IMAGE_PREFIX_LIMIT,
  type InspectedImage,
  inspectImagePrefix,
  validateObjectInfo,
} from "./image";

const CHUNK_SIZE = 64 * 1024;
const METADATA_FIELDS = [
  "schema",
  "fileId",
  "objectId",
  "role",
  "receiptToken",
  "bytes",
  "sha256",
  "mimeHint",
  "mime",
  "width",
  "height",
] as const;

function storageError() {
  return new FilesError(
    503,
    "File storage could not be verified. Use explicit reconciliation for an uncertain upload.",
  );
}
function inputError() {
  return new FilesError(
    400,
    "The upload body does not match the prepared byte length.",
  );
}
function transferError(error: unknown) {
  return error instanceof FilesError ? error : storageError();
}
function descriptorValid(descriptor: UploadDescriptor) {
  if (
    !descriptor ||
    !/^[0-9a-f]{64}$/.test(descriptor.expectedSha256) ||
    !/^[0-9a-f]{64}$/.test(descriptor.receiptToken) ||
    !FILE_MIMES.includes(descriptor.mimeHint) ||
    !["source", "thumbnail"].includes(descriptor.role) ||
    !descriptor.fileId ||
    !descriptor.objectId ||
    !descriptor.objectKey ||
    !Number.isSafeInteger(descriptor.expectedBytes) ||
    descriptor.expectedBytes < 1
  )
    throw storageError();
  if (
    descriptor.expectedBytes > FILE_LIMITS.sourceBytes ||
    (descriptor.mimeHint !== "application/octet-stream" &&
      descriptor.expectedBytes > FILE_LIMITS.imageBytes) ||
    (descriptor.role === "thumbnail" &&
      descriptor.expectedBytes > FILE_LIMITS.thumbnailBytes)
  )
    throw new FilesError(413, "The file exceeds the upload limit.");
  if (
    descriptor.role === "thumbnail" &&
    descriptor.mimeHint === "application/octet-stream"
  )
    throw new FilesError(415, "A thumbnail must use a supported image type.");
}
function checksumBytes(hex: string) {
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}
function checksumHex(value: ArrayBuffer | undefined) {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== 32)
    throw storageError();
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function metadata(
  descriptor: UploadDescriptor,
  info: InspectedImage,
): Record<string, string> {
  return {
    schema: "1",
    fileId: descriptor.fileId,
    objectId: descriptor.objectId,
    role: descriptor.role,
    receiptToken: descriptor.receiptToken,
    bytes: String(descriptor.expectedBytes),
    sha256: descriptor.expectedSha256,
    mimeHint: descriptor.mimeHint,
    mime: info.mime,
    width: info.width === null ? "" : String(info.width),
    height: info.height === null ? "" : String(info.height),
  };
}
function dimension(value: string | undefined) {
  if (value === "") return null;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value))
    throw storageError();
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw storageError();
  return number;
}

// Descriptor/receipt arguments are Worker-only D1 values, never request JSON.
// Upload expiry and credential versions intentionally do not gate ready reads.
export function verifyStoredObject(
  object: R2Object,
  descriptor: UploadDescriptor,
  expectedReceipt?: ObjectReceipt,
): ObjectReceipt {
  try {
    descriptorValid(descriptor);
    const stored = object.customMetadata;
    if (
      !stored ||
      Object.keys(stored).length !== METADATA_FIELDS.length ||
      METADATA_FIELDS.some((key) => typeof stored[key] !== "string")
    )
      throw storageError();
    const info: InspectedImage = {
      mime: descriptor.mimeHint,
      width: dimension(stored.width),
      height: dimension(stored.height),
    };
    validateObjectInfo(info, descriptor.expectedBytes, descriptor.role);
    const expectedMetadata = metadata(descriptor, info);
    if (
      Object.entries(expectedMetadata).some(
        ([key, value]) => stored[key] !== value,
      ) ||
      object.key !== descriptor.objectKey ||
      object.size !== descriptor.expectedBytes ||
      typeof object.version !== "string" ||
      object.version.length < 1 ||
      object.version.length > 256 ||
      Array.from(object.version).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }) ||
      object.httpMetadata?.contentType !== info.mime ||
      object.httpMetadata?.contentEncoding !== undefined ||
      checksumHex(object.checksums.sha256) !== descriptor.expectedSha256
    )
      throw storageError();
    const receipt: ObjectReceipt = {
      fileId: descriptor.fileId,
      objectId: descriptor.objectId,
      role: descriptor.role,
      objectKey: descriptor.objectKey,
      receiptToken: descriptor.receiptToken,
      bytes: object.size,
      sha256: descriptor.expectedSha256,
      ...info,
      r2Version: object.version,
    };
    if (
      expectedReceipt &&
      Object.entries(receipt).some(
        ([key, value]) => expectedReceipt[key as keyof ObjectReceipt] !== value,
      )
    )
      throw storageError();
    return receipt;
  } catch {
    throw storageError();
  }
}

export async function headStoredObject(
  bucket: R2Bucket,
  descriptor: UploadDescriptor,
  expectedReceipt: ObjectReceipt,
): Promise<R2Object | null> {
  try {
    const object = await bucket.head(descriptor.objectKey);
    if (object) verifyStoredObject(object, descriptor, expectedReceipt);
    return object;
  } catch {
    throw storageError();
  }
}

export async function getStoredObject(
  bucket: R2Bucket,
  descriptor: UploadDescriptor,
  expectedReceipt: ObjectReceipt,
  range?: R2Range,
): Promise<R2ObjectBody | null> {
  let object: R2ObjectBody | null = null;
  try {
    object = await bucket.get(
      descriptor.objectKey,
      range ? { range } : undefined,
    );
    if (object) verifyStoredObject(object, descriptor, expectedReceipt);
    return object;
  } catch {
    try {
      await object?.body.cancel();
    } catch {
      /* Do not expose storage details. */
    }
    throw storageError();
  }
}

export async function reconcilePreparedObject(
  bucket: R2Bucket,
  descriptor: UploadDescriptor,
): Promise<ObjectReceipt> {
  descriptorValid(descriptor);
  let object: R2Object | null;
  try {
    object = await bucket.head(descriptor.objectKey);
  } catch {
    throw storageError();
  }
  if (!object)
    throw new FilesError(409, "No completed object is available to reconcile.");
  return verifyStoredObject(object, descriptor);
}

export async function putPreparedObject(
  bucket: R2Bucket,
  descriptor: UploadDescriptor,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<ObjectReceipt> {
  descriptorValid(descriptor);
  if (!body || body.locked)
    throw new FilesError(400, "An unread upload body is required.");
  const source = body.getReader();
  // The pump handles read/write failures; also observe the stream lifecycle
  // promises so cancellation cannot leave a separate unhandled rejection.
  void source.closed.catch(() => undefined);
  let writer:
    | WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>
    | undefined;
  let bridge: FixedLengthStream | undefined;
  let stopped: FilesError | undefined;
  let seen = 0;
  const cancellations: Promise<unknown>[] = [];
  function cancel(operation: () => Promise<unknown>) {
    const pending = Promise.resolve()
      .then(operation)
      .catch(() => undefined);
    cancellations.push(pending);
  }
  function stop(error: FilesError) {
    if (stopped) return;
    stopped = error;
    cancel(() => source.cancel());
    const readable = bridge?.readable;
    const writable = writer;
    if (readable && !readable.locked) cancel(() => readable.cancel());
    if (writable) cancel(() => writable.abort());
  }
  function checkStopped() {
    if (stopped) throw stopped;
  }
  const abort = () => stop(new FilesError(400, "The upload was interrupted."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  async function readChunk(): Promise<Uint8Array | null> {
    checkStopped();
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await source.read();
    } catch {
      throw new FilesError(400, "The upload was interrupted.");
    }
    const { done, value } = result;
    checkStopped();
    if (done) return null;
    if (!(value instanceof Uint8Array)) throw inputError();
    seen += value.byteLength;
    if (seen > descriptor.expectedBytes) throw inputError();
    return value;
  }

  try {
    checkStopped();
    let info = inspectImagePrefix(
      new Uint8Array(),
      descriptor.mimeHint,
      descriptor.expectedBytes,
      descriptor.role,
    );
    const prefix = info
      ? new Uint8Array()
      : new Uint8Array(Math.min(IMAGE_PREFIX_LIMIT, descriptor.expectedBytes));
    let prefixLength = 0;
    let remainder: Uint8Array | null = null;
    while (!info) {
      if (!remainder?.length) remainder = await readChunk();
      if (remainder === null) throw inputError();
      if (!remainder.length) continue;
      const take = Math.min(
        CHUNK_SIZE,
        remainder.length,
        prefix.length - prefixLength,
      );
      prefix.set(remainder.subarray(0, take), prefixLength);
      prefixLength += take;
      remainder = remainder.subarray(take);
      info = inspectImagePrefix(
        prefix.subarray(0, prefixLength),
        descriptor.mimeHint,
        descriptor.expectedBytes,
        descriptor.role,
      );
    }
    const activeBridge = new FixedLengthStream(descriptor.expectedBytes);
    bridge = activeBridge;
    const activeWriter = activeBridge.writable.getWriter();
    void activeWriter.closed.catch(() => undefined);
    writer = activeWriter;
    const upload = (async () => {
      try {
        const object = await bucket.put(
          descriptor.objectKey,
          activeBridge.readable,
          {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            sha256: checksumBytes(descriptor.expectedSha256),
            storageClass: "Standard",
            httpMetadata: { contentType: info.mime },
            customMetadata: metadata(descriptor, info),
          },
        );
        if (object === null)
          throw new FilesError(
            409,
            "An object already exists. Reconcile it explicitly before continuing.",
          );
        return object;
      } catch (error) {
        const failure = transferError(error);
        stop(failure);
        throw failure;
      }
    })();
    const pump = (async () => {
      try {
        let tail: Uint8Array | undefined;
        async function feed(chunk: Uint8Array) {
          for (let offset = 0; offset < chunk.length; offset += CHUNK_SIZE) {
            checkStopped();
            if (tail) await activeWriter.write(tail);
            // Retain at most one small copied chunk, never a view retaining an
            // arbitrarily large incoming buffer, until exact-length EOF.
            tail = chunk.slice(offset, offset + CHUNK_SIZE);
          }
        }
        await feed(prefix.subarray(0, prefixLength));
        if (remainder) await feed(remainder);
        while (true) {
          const chunk = await readChunk();
          if (chunk === null) break;
          await feed(chunk);
        }
        if (seen !== descriptor.expectedBytes) throw inputError();
        checkStopped();
        if (tail) await activeWriter.write(tail);
        await activeWriter.close();
      } catch (error) {
        const failure = transferError(error);
        stop(failure);
        throw failure;
      }
    })();
    const [stored, pumped] = await Promise.allSettled([upload, pump]);
    if (stopped) throw stopped;
    if (stored.status !== "fulfilled" || pumped.status !== "fulfilled")
      throw storageError();
    const receipt = verifyStoredObject(stored.value, descriptor);
    if (
      receipt.mime !== info.mime ||
      receipt.width !== info.width ||
      receipt.height !== info.height
    )
      throw storageError();
    const object = await bucket.head(descriptor.objectKey);
    checkStopped();
    if (!object) throw storageError();
    return verifyStoredObject(object, descriptor, receipt);
  } catch (error) {
    const failure = transferError(error);
    stop(failure);
    throw failure;
  } finally {
    signal?.removeEventListener("abort", abort);
    await Promise.allSettled(cancellations);
    source.releaseLock();
    writer?.releaseLock();
  }
}
