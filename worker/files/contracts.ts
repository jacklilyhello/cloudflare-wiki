import type { FileEntry, FileMime, FileRole } from "../../shared/files";

export type { FileRole } from "../../shared/files";

export class FilesError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 412 | 413 | 415 | 416 | 503,
    message: string,
  ) {
    super(message);
    this.name = "FilesError";
  }
}

// Worker-only values. Never serialize these descriptors or receipts into an
// administrator/public response, a log or an error message.
export interface UploadDescriptor {
  fileId: string;
  objectId: string;
  role: FileRole;
  objectKey: string;
  receiptToken: string;
  expectedBytes: number;
  expectedSha256: string;
  mimeHint: FileMime;
  expiresAt: string;
  uploadAuthVersion: number;
  entryVersion: number;
}
export interface ObjectReceipt {
  fileId: string;
  objectId: string;
  role: FileRole;
  objectKey: string;
  receiptToken: string;
  bytes: number;
  sha256: string;
  mime: FileMime;
  width: number | null;
  height: number | null;
  r2Version: string;
}
export interface StoredObjectDescriptor extends UploadDescriptor {
  mime: FileMime;
  width: number | null;
  height: number | null;
  r2Version: string;
}
export interface StoredFileObject {
  entry: FileEntry;
  descriptor: UploadDescriptor;
  receipt: ObjectReceipt;
}
