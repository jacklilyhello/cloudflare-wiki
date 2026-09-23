import { FILE_LIMITS, type FileMime, type FileRole } from "../../shared/files";
import { FilesError } from "./contracts";

export const IMAGE_PREFIX_LIMIT = 1024 * 1024;
export interface InspectedImage {
  mime: FileMime;
  width: number | null;
  height: number | null;
}

function invalid(): never {
  throw new FilesError(
    415,
    "The image header is invalid or does not match its type.",
  );
}

export function validateObjectInfo(
  info: InspectedImage,
  bytes: number,
  role: FileRole,
): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > FILE_LIMITS.sourceBytes
  )
    throw new FilesError(413, "The file exceeds the upload limit.");
  if (info.mime === "application/octet-stream") {
    if (role !== "source" || info.width !== null || info.height !== null)
      invalid();
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(info.mime)) invalid();
  const { width, height } = info;
  if (
    width === null ||
    height === null ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    invalid();
  if (
    bytes > FILE_LIMITS.imageBytes ||
    width > FILE_LIMITS.imagePixels / height
  )
    throw new FilesError(413, "The image exceeds the size or pixel limit.");
  if (
    role === "thumbnail" &&
    (bytes > FILE_LIMITS.thumbnailBytes ||
      width > FILE_LIMITS.thumbnailEdge ||
      height > FILE_LIMITS.thumbnailEdge)
  )
    throw new FilesError(
      413,
      "The thumbnail exceeds the size or dimension limit.",
    );
}

function text(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
function byte(bytes: Uint8Array, offset: number) {
  const value = bytes[offset];
  if (value === undefined) invalid();
  return value;
}
function u16(bytes: Uint8Array, offset: number) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset);
}
function u32(bytes: Uint8Array, offset: number, little = false) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, little);
}
function u24(bytes: Uint8Array, offset: number) {
  return (
    byte(bytes, offset) +
    byte(bytes, offset + 1) * 256 +
    byte(bytes, offset + 2) * 65536
  );
}
function png(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 8) return null;
  if (
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  )
    invalid();
  if (bytes.length < 33) return null;
  if (u32(bytes, 8) !== 13 || text(bytes, 12, 4) !== "IHDR") invalid();
  const depth = byte(bytes, 24);
  const color = byte(bytes, 25);
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    !depths[color]?.includes(depth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    ![0, 1].includes(byte(bytes, 28))
  )
    invalid();
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  if ((crc ^ 0xffffffff) >>> 0 !== u32(bytes, 29)) invalid();
  return [u32(bytes, 16), u32(bytes, 20)];
}

function jpeg(
  bytes: Uint8Array,
  expectedBytes: number,
): [number, number] | null {
  if (bytes.length < 2) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = byte(bytes, offset++);
    if (marker === 0x01) continue;
    if (
      marker === 0 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0xda ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      invalid();
    if (offset + 2 > bytes.length) return null;
    const length = u16(bytes, offset);
    if (length < 2 || offset + length > expectedBytes) invalid();
    if (offset + length > bytes.length) return null;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      if (length < 8) invalid();
      const components = byte(bytes, offset + 7);
      const precision = byte(bytes, offset + 2);
      if (
        components < 1 ||
        components > 4 ||
        length !== 8 + components * 3 ||
        precision < 2 ||
        precision > 16 ||
        (marker === 0xc0 && precision !== 8)
      )
        invalid();
      return [u16(bytes, offset + 5), u16(bytes, offset + 3)];
    }
    offset += length;
  }
  return null;
}

function webp(
  bytes: Uint8Array,
  expectedBytes: number,
): [number, number] | null {
  if (bytes.length < 12) return null;
  if (
    text(bytes, 0, 4) !== "RIFF" ||
    text(bytes, 8, 4) !== "WEBP" ||
    u32(bytes, 4, true) + 8 !== expectedBytes
  )
    invalid();
  if (bytes.length < 20) return null;
  const kind = text(bytes, 12, 4);
  const length = u32(bytes, 16, true);
  if (20 + length + (length & 1) > expectedBytes) invalid();
  if (kind === "VP8X") {
    if (length !== 10) invalid();
    if (bytes.length < 30) return null;
    if (
      (byte(bytes, 20) & 0xc1) !== 0 ||
      bytes[21] !== 0 ||
      bytes[22] !== 0 ||
      bytes[23] !== 0
    )
      invalid();
    return [u24(bytes, 24) + 1, u24(bytes, 27) + 1];
  }
  if (kind === "VP8L") {
    if (length < 5) invalid();
    if (bytes.length < 25) return null;
    if (bytes[20] !== 0x2f) invalid();
    const bits = u32(bytes, 21, true);
    if (bits >>> 29 !== 0) invalid();
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (kind === "VP8 ") {
    if (length < 10) invalid();
    if (bytes.length < 30) return null;
    if (
      (byte(bytes, 20) & 1) !== 0 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    )
      invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    ];
  }
  return invalid();
}

// This inspects bounded format headers and dimensions, not the complete image
// or compressed pixels. An octet-stream hint is never upgraded to inline media.
export function inspectImagePrefix(
  prefix: Uint8Array,
  mimeHint: FileMime,
  expectedBytes: number,
  role: FileRole,
): InspectedImage | null {
  if (prefix.length > IMAGE_PREFIX_LIMIT) invalid();
  if (mimeHint === "application/octet-stream") {
    const info = { mime: mimeHint, width: null, height: null };
    validateObjectInfo(info, expectedBytes, role);
    return info;
  }
  const dimensions =
    mimeHint === "image/png"
      ? png(prefix)
      : mimeHint === "image/jpeg"
        ? jpeg(prefix, expectedBytes)
        : mimeHint === "image/webp"
          ? webp(prefix, expectedBytes)
          : invalid();
  if (!dimensions) {
    if (prefix.length >= IMAGE_PREFIX_LIMIT || prefix.length >= expectedBytes)
      invalid();
    return null;
  }
  const info = { mime: mimeHint, width: dimensions[0], height: dimensions[1] };
  validateObjectInfo(info, expectedBytes, role);
  return info;
}
