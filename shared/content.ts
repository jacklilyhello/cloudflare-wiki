import type { Language } from "./contracts";

export const CONTENT_LIMITS = {
  title: 200,
  description: 500,
  path: 240,
  tags: 16,
  tag: 64,
  changeNote: 500,
  revisionPage: 50,
} as const;

export interface DraftInput {
  title: string;
  description: string;
  markdown: string;
  tags: string[];
  changeNote?: string;
}

export interface CreateTranslationInput extends DraftInput {
  language: Language;
  path: string;
  pageId?: string;
}

export interface AdminTranslation {
  id: string;
  pageId: string;
  language: Language;
  path: string;
  version: number;
  revisionSeq: number;
  draftRevisionId: string | null;
  publishedRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  deletedAt: string | null;
}

export interface ContentRevision {
  id: string;
  translationId: string;
  revisionNo: number;
  title: string;
  description: string;
  markdown: string;
  tags: string[];
  changeNote: string;
  restoredFromRevisionId: string | null;
  createdAt: string;
}

export type RevisionSummary = Omit<ContentRevision, "markdown">;
export type ContentEventType =
  | "create"
  | "save_draft"
  | "publish"
  | "unpublish"
  | "move"
  | "delete"
  | "restore_revision"
  | "restore_deleted";
