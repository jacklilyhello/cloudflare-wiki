import type { Language } from "./contracts";

export const REDIRECT_LIMITS = {
  defaultPage: 25,
  page: 50,
  query: 200,
  cursor: 4096,
  body: 4096,
} as const;

export type RedirectOrigin = "automatic" | "manual";
export interface RedirectEntry {
  path: string;
  origin: RedirectOrigin;
  translationId: string;
  targetPath: string;
  targetTitle: string;
  targetStatus: "draft" | "published" | "deleted";
  createdAt: string;
}
export interface RedirectListOptions {
  origin?: RedirectOrigin;
  q?: string;
  translationId?: string;
  sourcePath?: string;
  cursor?: string;
  limit?: number;
}
export interface RedirectDocument {
  language: Language;
  version: number;
  items: RedirectEntry[];
  nextCursor: string | null;
}
export interface RedirectCreateInput {
  expectedVersion: number;
  path: string;
  translationId: string;
}
export interface RedirectUpdateInput extends RedirectCreateInput {
  sourcePath: string;
}
export interface RedirectDeleteInput {
  expectedVersion: number;
  sourcePath: string;
}
export interface RedirectMutationResult {
  language: Language;
  version: number;
  item: RedirectEntry;
}
export interface RedirectDeleteResult {
  language: Language;
  version: number;
}
