import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_LIMITS,
  type AuditAction,
  type AuditCategory,
  type AuditListOptions,
  type AuditOrigin,
  type AuditPage,
  type AuditRecord,
} from "../../shared/audit";
import type { Language } from "../../shared/contracts";
import { SETTINGS_FIELDS, type SettingsField } from "../../shared/settings";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";

export class AuditError extends Error {
  constructor(
    readonly status: 400 | 401 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AuditError";
  }
}
type Filters = {
  category: AuditCategory | null;
  action: AuditAction | null;
  language: Language | "site" | null;
  subjectId: string | null;
  from: string | null;
  to: string | null;
};
type Row = {
  seq: number;
  category: AuditCategory;
  subject_id: string;
  subject_version: number;
  action: AuditAction;
  language: Language | null;
  origin: AuditOrigin;
  created_at: string;
  details_json: string;
  page_title: string | null;
};
function invalid(message = "Invalid audit filters."): never {
  throw new AuditError(400, message);
}
function storageFailure(): never {
  throw new AuditError(503, "Audit storage is temporarily unavailable.");
}
function dateFilter(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid("Invalid audit timestamp.");
  return value;
}
function filters(options: AuditListOptions): Filters {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          "category",
          "action",
          "language",
          "subjectId",
          "from",
          "to",
          "cursor",
          "limit",
        ].includes(key),
    ) ||
    (options.category !== undefined &&
      !AUDIT_CATEGORIES.includes(options.category)) ||
    (options.action !== undefined && !AUDIT_ACTIONS.includes(options.action)) ||
    (options.category !== undefined &&
      options.action !== undefined &&
      !options.action.startsWith(`${options.category}.`)) ||
    (options.language !== undefined &&
      !["zh", "en", "site"].includes(options.language)) ||
    (options.subjectId !== undefined &&
      (typeof options.subjectId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(options.subjectId)))
  )
    invalid();
  const from = dateFilter(options.from);
  const to = dateFilter(options.to);
  if (from !== null && to !== null && from >= to)
    invalid("The audit time range must end after it starts.");
  return {
    category: options.category ?? null,
    action: options.action ?? null,
    language: options.language ?? null,
    subjectId: options.subjectId ?? null,
    from,
    to,
  };
}
function encodeCursor(before: number, scope: Filters) {
  return btoa(JSON.stringify({ v: 1, before, filters: scope }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decodeCursor(value: unknown, scope: Filters): number | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > AUDIT_LIMITS.cursor ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    invalid("Invalid audit cursor.");
  try {
    const cursor = JSON.parse(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (
      !cursor ||
      !Number.isSafeInteger(cursor.before) ||
      cursor.before < 1 ||
      value !== encodeCursor(cursor.before, scope)
    )
      invalid("Invalid audit cursor.");
    return cursor.before;
  } catch {
    invalid("Invalid audit cursor.");
  }
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function exactObject(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

// Decode only this closed metadata schema; never return an arbitrary stored object.
function record(row: Row): AuditRecord {
  const details: unknown = JSON.parse(row.details_json);
  const base = {
    seq: row.seq,
    subjectId: row.subject_id,
    subjectVersion: row.subject_version,
    origin: row.origin,
    createdAt: row.created_at,
  };
  if (row.category === "page") {
    if (
      !row.action.startsWith("page.") ||
      !row.language ||
      !exactObject(details, ["revisionId", "fromPath", "toPath"]) ||
      !nullableString(details.revisionId) ||
      !nullableString(details.fromPath) ||
      !nullableString(details.toPath)
    )
      storageFailure();
    return {
      ...base,
      category: "page",
      action: row.action as Extract<AuditAction, `page.${string}`>,
      language: row.language,
      details: {
        revisionId: details.revisionId,
        fromPath: details.fromPath,
        toPath: details.toPath,
      },
      pageTitle: row.page_title,
    };
  }
  if (row.category === "navigation") {
    if (
      row.action !== "navigation.save" ||
      !row.language ||
      !exactObject(details, ["previousMode", "mode", "nodeCount"]) ||
      (details.previousMode !== "automatic" &&
        details.previousMode !== "custom") ||
      (details.mode !== "automatic" && details.mode !== "custom") ||
      typeof details.nodeCount !== "number" ||
      !Number.isSafeInteger(details.nodeCount) ||
      details.nodeCount < 0 ||
      details.nodeCount > 300
    )
      storageFailure();
    return {
      ...base,
      category: "navigation",
      action: row.action,
      language: row.language,
      details: {
        previousMode: details.previousMode,
        mode: details.mode,
        nodeCount: details.nodeCount,
      },
      pageTitle: null,
    };
  }
  if (row.category === "settings") {
    if (
      row.action !== "settings.update" ||
      row.language !== null ||
      row.subject_id !== "1" ||
      row.origin !== "current" ||
      !exactObject(details, ["changedFields"]) ||
      !Array.isArray(details.changedFields) ||
      details.changedFields.length < 1 ||
      details.changedFields.length > SETTINGS_FIELDS.length ||
      new Set(details.changedFields).size !== details.changedFields.length ||
      !details.changedFields.every(
        (field) =>
          typeof field === "string" &&
          SETTINGS_FIELDS.includes(field as SettingsField),
      )
    )
      storageFailure();
    return {
      ...base,
      category: "settings",
      action: "settings.update",
      language: null,
      details: { changedFields: details.changedFields as SettingsField[] },
      pageTitle: null,
    };
  }
  if (row.category === "redirect") {
    if (
      !["redirect.create", "redirect.update", "redirect.delete"].includes(
        row.action,
      ) ||
      (row.language !== "zh" && row.language !== "en") ||
      row.subject_id !== row.language ||
      !exactObject(details, [
        "sourcePath",
        "previousPath",
        "targetTranslationId",
        "previousTarget",
      ]) ||
      !nullableString(details.sourcePath) ||
      !nullableString(details.previousPath) ||
      !nullableString(details.targetTranslationId) ||
      !nullableString(details.previousTarget) ||
      (row.action === "redirect.create"
        ? details.previousPath !== null ||
          details.previousTarget !== null ||
          typeof details.sourcePath !== "string" ||
          typeof details.targetTranslationId !== "string"
        : row.action === "redirect.delete"
          ? details.sourcePath !== null ||
            details.targetTranslationId !== null ||
            typeof details.previousPath !== "string" ||
            typeof details.previousTarget !== "string"
          : typeof details.sourcePath !== "string" ||
            typeof details.targetTranslationId !== "string" ||
            typeof details.previousPath !== "string" ||
            typeof details.previousTarget !== "string")
    )
      storageFailure();
    return {
      ...base,
      category: "redirect",
      action: row.action as Extract<AuditAction, `redirect.${string}`>,
      language: row.language,
      details: {
        sourcePath: details.sourcePath,
        previousPath: details.previousPath,
        targetTranslationId: details.targetTranslationId,
        previousTarget: details.previousTarget,
      },
      pageTitle: null,
    };
  }
  if (
    row.category !== "administrator" ||
    row.language !== null ||
    (row.action !== "administrator.initialize" &&
      row.action !== "administrator.credentials")
  )
    storageFailure();
  if (row.action === "administrator.initialize") {
    if (details !== null) storageFailure();
    return {
      ...base,
      category: "administrator",
      action: row.action,
      language: null,
      details: null,
      pageTitle: null,
    };
  }
  if (
    !exactObject(details, ["usernameChanged", "passwordChanged"]) ||
    typeof details.usernameChanged !== "boolean" ||
    typeof details.passwordChanged !== "boolean"
  )
    storageFailure();
  return {
    ...base,
    category: "administrator",
    action: row.action,
    language: null,
    details: {
      usernameChanged: details.usernameChanged,
      passwordChanged: details.passwordChanged,
    },
    pageTitle: null,
  };
}

export class AuditService {
  private readonly access: ContentWriteAccess;
  constructor(
    private readonly db: D1Database,
    access: ContentWriteAccess,
  ) {
    this.access = Object.freeze({ ...access });
    this.session();
  }
  private session() {
    try {
      return sessionGuard(this.access);
    } catch {
      throw new AuditError(401, "Authentication required.");
    }
  }
  async list(options: AuditListOptions = {}): Promise<AuditPage> {
    const scope = filters(options);
    const limit = options.limit ?? AUDIT_LIMITS.defaultPage;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AUDIT_LIMITS.page)
      invalid("Invalid audit page size.");
    const before = decodeCursor(options.cursor, scope);
    const guard = this.session();
    const predicates = [guard.sql];
    const values: (string | number | null)[] = [...guard.values];
    for (const [column, value] of [
      ["category", scope.category],
      ["action", scope.action],
      ["subject_id", scope.subjectId],
    ]) {
      if (value !== null) {
        predicates.push(`a.${column}=?`);
        values.push(value ?? null);
      }
    }
    if (scope.language === "site") predicates.push("a.language IS NULL");
    else if (scope.language !== null) {
      predicates.push("a.language=?");
      values.push(scope.language);
    }
    if (scope.from !== null) {
      predicates.push("a.created_at>=?");
      values.push(scope.from);
    }
    if (scope.to !== null) {
      predicates.push("a.created_at<?");
      values.push(scope.to);
    }
    if (before !== null) {
      predicates.push("a.seq<?");
      values.push(before);
    }
    values.push(limit + 1);
    try {
      const rows = await this.db
        .prepare(`SELECT a.*,r.title AS page_title
        FROM audit_records a
        LEFT JOIN page_events e ON e.id=a.source_page_event_id AND e.translation_id=a.subject_id
        LEFT JOIN page_revisions r ON r.id=e.revision_id AND r.translation_id=e.translation_id
        WHERE ${predicates.join(" AND ")} ORDER BY a.seq DESC LIMIT ?`)
        .bind(...values)
        .all<Row>();
      if (!rows.results.length) {
        const live = this.session();
        if (
          !(await this.db
            .prepare(`SELECT 1 WHERE ${live.sql}`)
            .bind(...live.values)
            .first())
        )
          throw new AuditError(401, "Authentication required.");
      }
      const items = rows.results.slice(0, limit).map(record);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.results.length > limit && last
            ? encodeCursor(last.seq, scope)
            : null,
      };
    } catch (error) {
      if (error instanceof AuditError) throw error;
      storageFailure();
    }
  }
}
