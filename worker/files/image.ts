import {
  FileImageError,
  type InspectedImage,
  inspectImagePrefix as inspect,
  validateObjectInfo as validate,
} from "../../shared/file-image";
import type { FileMime, FileRole } from "../../shared/files";
import { FilesError } from "./contracts";

export {
  IMAGE_PREFIX_LIMIT,
  type InspectedImage,
} from "../../shared/file-image";

function adapt<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof FileImageError)
      throw new FilesError(error.status, error.message);
    throw error;
  }
}

export function validateObjectInfo(
  info: InspectedImage,
  bytes: number,
  role: FileRole,
): void {
  adapt(() => validate(info, bytes, role));
}

export function inspectImagePrefix(
  prefix: Uint8Array,
  mimeHint: FileMime,
  expectedBytes: number,
  role: FileRole,
): InspectedImage | null {
  return adapt(() => inspect(prefix, mimeHint, expectedBytes, role));
}
