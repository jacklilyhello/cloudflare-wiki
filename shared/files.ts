export const FILE_LIMITS = {
  name: 200,
  alt: 500,
  query: 200,
  cursor: 4096,
  defaultPage: 25,
  page: 50,
  body: 4096,
  sourceBytes: 20 * 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  imagePixels: 25_000_000,
  thumbnailBytes: 256 * 1024,
  thumbnailEdge: 320,
  folderDepth: 8,
  uploadMs: 15 * 60 * 1000,
} as const;
export const FILE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/octet-stream",
] as const;
export const FILE_FIELDS = [
  "name",
  "parentId",
  "alt.zh",
  "alt.en",
  "state",
  "thumbnailState",
  "visibility",
  "deletedAt",
] as const;
export const FILE_ACTIONS = [
  "file.create_folder",
  "file.prepare",
  "file.finalize",
  "file.thumbnail",
  "file.rename",
  "file.move",
  "file.alt",
  "file.publish",
  "file.unpublish",
  "file.delete",
  "file.restore",
  "file.abandon",
] as const;
export type FileField = (typeof FILE_FIELDS)[number];
export type FileAction = (typeof FILE_ACTIONS)[number];
export type FileMime = (typeof FILE_MIMES)[number];
export type FileRole = "source" | "thumbnail";
export type FileState = "pending" | "ready" | "abandoned";
export type ThumbnailState = "none" | "pending" | "ready" | "abandoned";
export interface ObjectInput {
  bytes: number;
  sha256: string;
  mimeHint: FileMime;
}
export interface ObjectInfo {
  bytes: number;
  mime: FileMime;
  width: number | null;
  height: number | null;
}
export interface FileEntry {
  id: string;
  kind: "file" | "folder";
  parentId: string | null;
  name: string;
  version: number;
  state: FileState;
  thumbnailState: ThumbnailState;
  alt: { zh: string; en: string } | null;
  source: ObjectInfo | null;
  thumbnail: ObjectInfo | null;
  uploadExpiresAt: string | null;
  publishedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FileListOptions {
  parentId?: string | null;
  state?: "active" | "deleted";
  q?: string;
  cursor?: string;
  limit?: number;
}
export interface FilePage {
  libraryVersion: number;
  items: FileEntry[];
  nextCursor: string | null;
}
export interface CreateFolderInput {
  expectedLibraryVersion: number;
  parentId: string | null;
  name: string;
}
export interface PrepareUploadInput extends CreateFolderInput {
  source: ObjectInput;
  thumbnail?: ObjectInput;
}
export interface RenameFileInput {
  expectedVersion: number;
  name: string;
}
export interface MoveFileInput {
  expectedVersion: number;
  parentId: string | null;
}
export interface FileAltInput {
  expectedVersion: number;
  alt: { zh: string; en: string };
}
