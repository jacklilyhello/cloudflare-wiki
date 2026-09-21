import type { Language } from "./contracts";

export const AUDIT_CATEGORIES = [
  "page",
  "navigation",
  "administrator",
] as const;
export const AUDIT_ACTIONS = [
  "page.create",
  "page.save_draft",
  "page.publish",
  "page.unpublish",
  "page.move",
  "page.delete",
  "page.restore_revision",
  "page.restore_deleted",
  "navigation.save",
  "administrator.initialize",
  "administrator.credentials",
] as const;
export const AUDIT_LIMITS = {
  defaultPage: 25,
  page: 50,
  cursor: 2048,
  subjectId: 128,
  detailsBytes: 2048,
} as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOrigin = "legacy" | "current";
export interface PageAuditDetails {
  revisionId: string | null;
  fromPath: string | null;
  toPath: string | null;
}
export interface NavigationAuditDetails {
  previousMode: "automatic" | "custom";
  mode: "automatic" | "custom";
  nodeCount: number;
}
export interface AdministratorAuditDetails {
  usernameChanged: boolean;
  passwordChanged: boolean;
}
interface AuditBase {
  seq: number;
  subjectId: string;
  subjectVersion: number;
  origin: AuditOrigin;
  createdAt: string;
}
export type AuditRecord = AuditBase &
  (
    | {
        category: "page";
        action: Extract<AuditAction, `page.${string}`>;
        language: Language;
        details: PageAuditDetails;
        pageTitle: string | null;
      }
    | {
        category: "navigation";
        action: "navigation.save";
        language: Language;
        details: NavigationAuditDetails;
        pageTitle: null;
      }
    | {
        category: "administrator";
        action: "administrator.initialize" | "administrator.credentials";
        language: null;
        details: AdministratorAuditDetails | null;
        pageTitle: null;
      }
  );

export interface AuditListOptions {
  category?: AuditCategory;
  action?: AuditAction;
  language?: Language | "site";
  subjectId?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface AuditPage {
  items: AuditRecord[];
  nextCursor: string | null;
}
