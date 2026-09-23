import type { AdminTranslation, PageSummary } from "./content";
import type { Language } from "./contracts";

export const DIRECTORY_LIMITS = {
  defaultPage: 25,
  page: 50,
  move: 25,
  cursor: 4096,
  bodyBytes: 16 * 1024,
} as const;

// Directories are derived from active canonical paths. A node may be both a
// page and a parent; no empty-folder records or new public routes are created.
export interface PageDirectoryItem {
  path: string;
  segment: string;
  page: PageSummary | null;
  hasChildren: boolean;
}
export interface PageDirectoryOptions {
  path?: string;
  cursor?: string;
  limit?: number;
}
export interface PageDirectory {
  language: Language;
  path: string;
  version: number;
  page: PageSummary | null;
  items: PageDirectoryItem[];
  nextCursor: string | null;
}
export interface DirectoryMoveInput {
  fromPath: string;
  toPath: string;
}
export interface DirectoryMoveMember {
  id: string;
  version: number;
  fromPath: string;
  toPath: string;
  title: string;
  published: boolean;
}
export interface DirectoryMovePreview extends DirectoryMoveInput {
  language: Language;
  version: number;
  members: DirectoryMoveMember[];
  publishedCount: number;
}
export interface DirectoryMoveCommit extends DirectoryMoveInput {
  expectedVersion: number;
  expectedMembers: { id: string; version: number }[];
}
export interface DirectoryMoveResult extends DirectoryMoveInput {
  language: Language;
  version: number;
  items: AdminTranslation[];
}
