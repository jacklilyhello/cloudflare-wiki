import {
  FileImageError,
  IMAGE_PREFIX_LIMIT,
  type InspectedImage,
  inspectImagePrefix,
  validateObjectInfo,
} from "../../shared/file-image";
import {
  FILE_LIMITS,
  type FileMime,
  type ObjectInput,
} from "../../shared/files";

export type PreparationPhase = "checking" | "hashing" | "thumbnail";
export interface PreparedBrowserObject {
  body: Blob;
  input: ObjectInput;
}
export interface PreparedBrowserFile {
  source: PreparedBrowserObject;
  thumbnail: PreparedBrowserObject | null;
  thumbnailOmitted: boolean;
}
export interface DecodedFileImage {
  width: number;
  height: number;
  close(): void;
}
export interface ThumbnailRenderer {
  decode(blob: Blob): Promise<DecodedFileImage>;
  encode(
    image: DecodedFileImage,
    width: number,
    height: number,
  ): Promise<Blob | null>;
}
// Structural browser interfaces keep the pure preparation tests runnable in
// workerd. No browser module imports a Worker implementation or credentials.
interface ThumbnailCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): {
    drawImage(
      image: DecodedFileImage,
      x: number,
      y: number,
      width: number,
      height: number,
    ): void;
  } | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type: string,
    quality?: number,
  ): void;
}
const nativeRenderer: ThumbnailRenderer = {
  decode(blob) {
    const browser = globalThis as unknown as {
      createImageBitmap(blob: Blob): Promise<DecodedFileImage>;
    };
    return browser.createImageBitmap(blob);
  },
  async encode(image, width, height) {
    const browser = globalThis as unknown as {
      document: { createElement(name: "canvas"): ThumbnailCanvas };
    };
    const canvas = browser.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(image, 0, 0, width, height);
      // Browsers may fall back to PNG. The actual returned type and bytes are
      // validated below; there is no data/blob URL or external image request.
      return await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.8),
      );
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  },
};

export function checkFileAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("Upload interrupted", "AbortError");
}
function mime(type: string): FileMime {
  return type === "image/png" || type === "image/jpeg" || type === "image/webp"
    ? type
    : "application/octet-stream";
}
async function inspect(
  blob: Blob,
  hint: FileMime,
  role: "source" | "thumbnail",
  signal?: AbortSignal,
): Promise<InspectedImage> {
  checkFileAbort(signal);
  if (
    !Number.isSafeInteger(blob.size) ||
    blob.size < 1 ||
    blob.size > FILE_LIMITS.sourceBytes ||
    (hint !== "application/octet-stream" &&
      blob.size > FILE_LIMITS.imageBytes) ||
    (role === "thumbnail" && blob.size > FILE_LIMITS.thumbnailBytes)
  )
    throw new FileImageError(413, "The file exceeds the upload limit.");
  const prefix =
    hint === "application/octet-stream"
      ? new Uint8Array()
      : new Uint8Array(await blob.slice(0, IMAGE_PREFIX_LIMIT).arrayBuffer());
  checkFileAbort(signal);
  const info = inspectImagePrefix(prefix, hint, blob.size, role);
  if (!info)
    throw new FileImageError(415, "The image header could not be verified.");
  return info;
}
async function hash(
  blob: Blob,
  hint: FileMime,
  signal?: AbortSignal,
): Promise<PreparedBrowserObject> {
  checkFileAbort(signal);
  // WebCrypto requires one input buffer. The browser reads at most the already
  // checked 20 MiB source; the Worker still streams without buffering it.
  const buffer = await blob.arrayBuffer();
  checkFileAbort(signal);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  checkFileAbort(signal);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { body: blob, input: { bytes: blob.size, sha256, mimeHint: hint } };
}

export async function prepareBrowserFile(
  file: Blob,
  options: {
    thumbnail: boolean;
    signal?: AbortSignal;
    onPhase?: (phase: PreparationPhase) => void;
  },
  renderer: ThumbnailRenderer = nativeRenderer,
): Promise<PreparedBrowserFile> {
  const { signal } = options;
  options.onPhase?.("checking");
  const hint = mime(file.type);
  await inspect(file, hint, "source", signal);
  options.onPhase?.("hashing");
  const source = await hash(file, hint, signal);
  let thumbnail: PreparedBrowserObject | null = null;
  let thumbnailOmitted = false;
  if (options.thumbnail && hint !== "application/octet-stream") {
    options.onPhase?.("thumbnail");
    let image: DecodedFileImage | undefined;
    try {
      image = await renderer.decode(file);
      checkFileAbort(signal);
      validateObjectInfo(
        { mime: hint, width: image.width, height: image.height },
        file.size,
        "source",
      );
      const scale = Math.min(
        1,
        FILE_LIMITS.thumbnailEdge / Math.max(image.width, image.height),
      );
      const width = Math.max(1, Math.floor(image.width * scale));
      const height = Math.max(1, Math.floor(image.height * scale));
      const encoded = await renderer.encode(image, width, height);
      checkFileAbort(signal);
      if (!encoded || mime(encoded.type) === "application/octet-stream")
        throw new Error("Thumbnail unavailable");
      const thumbnailHint = mime(encoded.type);
      await inspect(encoded, thumbnailHint, "thumbnail", signal);
      thumbnail = await hash(encoded, thumbnailHint, signal);
    } catch {
      checkFileAbort(signal);
      thumbnailOmitted = true;
    } finally {
      image?.close();
    }
  }
  checkFileAbort(signal);
  return { source, thumbnail, thumbnailOmitted };
}
