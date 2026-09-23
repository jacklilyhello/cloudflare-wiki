import type { Language } from "../../shared/contracts";
import {
  REDIRECT_LIMITS,
  type RedirectCreateInput,
  type RedirectDeleteInput,
  type RedirectDeleteResult,
  type RedirectDocument,
  type RedirectEntry,
  type RedirectListOptions,
  type RedirectMutationResult,
  type RedirectUpdateInput,
} from "../../shared/redirects";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";
import { validateContentPath } from "../content/service";

export class RedirectError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 412 | 503,
    message: string,
  ) {
    super(message);
    this.name = "RedirectError";
  }
}
type Scope = {
  language: Language;
  origin: "automatic" | "manual" | null;
  q: string | null;
  translationId: string | null;
  sourcePath: string | null;
};
type Cursor = { version: number; after: string };
type Context = {
  version: number | null;
  source_exists: number;
  source_canonical: number;
  destination_canonical: number;
  target_language: Language | null;
  target_deleted: string | null;
};
type SqlValue = string | number | null;

const joins = `FROM page_routes a JOIN page_translations t ON t.id=a.translation_id AND t.language=a.language
  LEFT JOIN page_revisions d ON d.id=t.draft_revision_id AND d.translation_id=t.id
  LEFT JOIN page_revisions p ON p.id=t.published_revision_id AND p.translation_id=t.id`;
const columns = `a.path,a.origin,a.translation_id AS translationId,t.slug AS targetPath,
  coalesce(d.title,p.title,t.slug) AS targetTitle,a.created_at AS createdAt,
  CASE WHEN t.deleted_at IS NOT NULL THEN 'deleted' WHEN p.id IS NOT NULL THEN 'published' ELSE 'draft' END AS targetStatus`;
const notCanonical = `NOT EXISTS(SELECT 1 FROM page_translations c WHERE c.language=a.language AND c.slug=a.path)`;

function invalid(message = "Invalid redirect input."): never {
  throw new RedirectError(400, message);
}
function stale(): never {
  throw new RedirectError(
    412,
    "The redirect registry changed. Reload before retrying.",
  );
}
function storage(): never {
  throw new RedirectError(503, "Redirect storage is temporarily unavailable.");
}
function language(value: Language): Language {
  if (value !== "zh" && value !== "en") invalid("Invalid redirect language.");
  return value;
}
function path(value: unknown): string {
  try {
    return validateContentPath(value);
  } catch {
    invalid("Invalid redirect path.");
  }
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  )
    invalid("Invalid redirect target.");
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid("Invalid redirect version.");
  return value;
}
function object(value: unknown, allowed: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    invalid();
}
function encodeCursor(cursor: Cursor, scope: Scope) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, ...cursor, scope }),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decodeCursor(value: unknown, scope: Scope): Cursor | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > REDIRECT_LIMITS.cursor ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    invalid("Invalid redirect cursor.");
  try {
    const text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(text, (char) => char.charCodeAt(0)),
      ),
    );
    const cursor = {
      version: version(parsed.version),
      after: path(parsed.after),
    };
    if (encodeCursor(cursor, scope) !== value) invalid();
    return cursor;
  } catch {
    invalid("Invalid redirect cursor.");
  }
}

export class RedirectService {
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
      throw new RedirectError(401, "Authentication required.");
    }
  }
  private statement(sql: string, values: SqlValue[] = []) {
    try {
      return this.db.prepare(sql).bind(...values);
    } catch {
      storage();
    }
  }
  private registry(locale: Language, session: ReturnType<typeof sessionGuard>) {
    // A left join distinguishes missing storage from an invalid session. Never
    // repeat the caller's old version predicate in a post-mutation read.
    return this.statement(
      `SELECT r.version FROM (SELECT 1) LEFT JOIN route_registries r ON r.language=? WHERE ${session.sql}`,
      [locale, ...session.values],
    );
  }
  private readVersion(row: { version: number | null } | undefined) {
    if (!row) throw new RedirectError(401, "Authentication required.");
    if (
      row.version === null ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1
    )
      storage();
    return row.version;
  }
  private failure(error: unknown): never {
    if (error instanceof RedirectError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (
      /UNIQUE constraint failed: page_routes\.|PRIMARY KEY constraint failed: page_routes\.|redirect_canonical/.test(
        message,
      )
    )
      throw new RedirectError(
        409,
        "This path is already in use or is canonical.",
      );
    storage();
  }
  async list(
    locale: Language,
    options: RedirectListOptions = {},
  ): Promise<RedirectDocument> {
    language(locale);
    object(options, [
      "origin",
      "q",
      "translationId",
      "sourcePath",
      "cursor",
      "limit",
    ]);
    if (
      options.origin !== undefined &&
      options.origin !== "automatic" &&
      options.origin !== "manual"
    )
      invalid();
    if (
      options.q !== undefined &&
      (typeof options.q !== "string" ||
        options.q.length > REDIRECT_LIMITS.query)
    )
      invalid("Invalid redirect query.");
    const query = options.q?.normalize("NFKC").trim().toLowerCase() || null;
    if (query && query.length > REDIRECT_LIMITS.query)
      invalid("Invalid redirect query.");
    const scope: Scope = {
      language: locale,
      origin: options.origin ?? null,
      q: query,
      translationId:
        options.translationId === undefined
          ? null
          : identifier(options.translationId),
      sourcePath:
        options.sourcePath === undefined ? null : path(options.sourcePath),
    };
    const limit = options.limit ?? REDIRECT_LIMITS.defaultPage;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > REDIRECT_LIMITS.page
    )
      invalid("Invalid redirect page size.");
    const cursor = decodeCursor(options.cursor, scope);
    const session = this.session();
    const predicates = ["a.language=?", notCanonical, session.sql];
    const values: SqlValue[] = [locale, ...session.values];
    for (const [column, value] of [
      ["origin", scope.origin],
      ["translation_id", scope.translationId],
      ["path", scope.sourcePath],
    ] as const) {
      if (value !== null) {
        predicates.push(`a.${column}=?`);
        values.push(value);
      }
    }
    if (scope.q !== null) {
      predicates.push("instr(a.path,?)>0");
      values.push(scope.q);
    }
    if (cursor) {
      predicates.push(
        "a.path>?",
        "EXISTS(SELECT 1 FROM route_registries r WHERE r.language=a.language AND r.version=?)",
      );
      values.push(cursor.after, cursor.version);
    }
    values.push(limit + 1);
    try {
      const results = await this.db.batch([
        this.registry(locale, session),
        this.statement(
          `SELECT ${columns} ${joins} WHERE ${predicates.join(" AND ")} ORDER BY a.path LIMIT ?`,
          values,
        ),
      ]);
      const currentVersion = this.readVersion(
        results[0]?.results[0] as { version: number | null } | undefined,
      );
      if (cursor && cursor.version !== currentVersion) stale();
      const rows = (results[1]?.results ?? []) as unknown as RedirectEntry[];
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        language: locale,
        version: currentVersion,
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ version: currentVersion, after: last.path }, scope)
            : null,
      };
    } catch (error) {
      this.failure(error);
    }
  }
  async create(
    locale: Language,
    input: RedirectCreateInput,
  ): Promise<RedirectMutationResult> {
    const result = await this.mutate("create", locale, input);
    if (!result.item) storage();
    return { ...result, item: result.item };
  }
  async update(
    locale: Language,
    input: RedirectUpdateInput,
  ): Promise<RedirectMutationResult> {
    const result = await this.mutate("update", locale, input);
    if (!result.item) storage();
    return { ...result, item: result.item };
  }
  async delete(
    locale: Language,
    input: RedirectDeleteInput,
  ): Promise<RedirectDeleteResult> {
    const result = await this.mutate("delete", locale, input);
    return { language: result.language, version: result.version };
  }
  private async mutate(
    operation: "create" | "update" | "delete",
    locale: Language,
    input: RedirectCreateInput | RedirectUpdateInput | RedirectDeleteInput,
  ) {
    language(locale);
    const allowed =
      operation === "create"
        ? ["expectedVersion", "path", "translationId"]
        : operation === "update"
          ? ["expectedVersion", "sourcePath", "path", "translationId"]
          : ["expectedVersion", "sourcePath"];
    object(input, allowed);
    const expected = version(input.expectedVersion);
    const source =
      operation === "create"
        ? null
        : path((input as RedirectDeleteInput).sourcePath);
    const destination =
      operation === "delete" ? null : path((input as RedirectCreateInput).path);
    const target =
      operation === "delete"
        ? null
        : identifier((input as RedirectCreateInput).translationId);
    const session = this.session();
    const guard = `EXISTS(SELECT 1 FROM route_registries r WHERE r.language=? AND r.version=?) AND ${session.sql}`;
    const guardValues = [locale, expected, ...session.values];
    const destinationFree =
      "NOT EXISTS(SELECT 1 FROM page_translations c WHERE c.language=? AND c.slug=?)";
    let write: D1PreparedStatement;
    if (operation === "create") {
      write = this.statement(
        `INSERT INTO page_routes(language,path,translation_id,created_at,origin)
        SELECT ?,?,t.id,?,'manual' FROM page_translations t WHERE t.id=? AND t.language=? AND t.deleted_at IS NULL AND ${destinationFree} AND ${guard} RETURNING path`,
        [
          locale,
          destination,
          new Date().toISOString(),
          target,
          locale,
          locale,
          destination,
          ...guardValues,
        ],
      );
    } else if (operation === "update") {
      write = this.statement(
        `UPDATE page_routes AS a SET path=?,translation_id=? WHERE a.language=? AND a.path=? AND ${notCanonical}
        AND EXISTS(SELECT 1 FROM page_translations t WHERE t.id=? AND t.language=? AND t.deleted_at IS NULL) AND ${destinationFree} AND ${guard} RETURNING path`,
        [
          destination,
          target,
          locale,
          source,
          target,
          locale,
          locale,
          destination,
          ...guardValues,
        ],
      );
    } else {
      write = this.statement(
        `DELETE FROM page_routes AS a WHERE a.language=? AND a.path=? AND ${notCanonical} AND ${guard} RETURNING path`,
        [locale, source, ...guardValues],
      );
    }
    // Diagnostics and the resulting item are read in the same D1 snapshot as
    // the guarded write, including when a concurrent writer wins first.
    const context = this.statement(
      `SELECT r.version,
      EXISTS(SELECT 1 FROM page_routes a WHERE a.language=? AND a.path=?) AS source_exists,
      EXISTS(SELECT 1 FROM page_translations c WHERE c.language=? AND c.slug=?) AS source_canonical,
      EXISTS(SELECT 1 FROM page_translations c WHERE c.language=? AND c.slug=?) AS destination_canonical,
      t.language AS target_language,t.deleted_at AS target_deleted
      FROM (SELECT 1) LEFT JOIN route_registries r ON r.language=?
      LEFT JOIN page_translations t ON t.id=? WHERE ${session.sql}`,
      [
        locale,
        source,
        locale,
        source,
        locale,
        destination,
        locale,
        target,
        ...session.values,
      ],
    );
    const statements = [write, context];
    if (operation !== "delete")
      statements.push(
        this.statement(
          `SELECT ${columns} ${joins} WHERE a.language=? AND a.path=? AND ${session.sql}`,
          [locale, destination, ...session.values],
        ),
      );
    try {
      const results = await this.db.batch(statements);
      const state = results[1]?.results[0] as Context | undefined;
      const currentVersion = this.readVersion(state);
      if (!results[0]?.results.length) {
        if (currentVersion !== expected) stale();
        if (!state) storage();
        if (source !== null) {
          if (!state.source_exists)
            throw new RedirectError(404, "Redirect not found.");
          if (state.source_canonical)
            throw new RedirectError(
              409,
              "Canonical page paths cannot be changed here.",
            );
        }
        if (destination !== null && state.destination_canonical)
          throw new RedirectError(
            409,
            "Canonical page paths cannot be changed here.",
          );
        if (target !== null) {
          if (state.target_language === null)
            throw new RedirectError(404, "Target page not found.");
          if (state.target_language !== locale)
            invalid("The target must use the same language.");
          if (state.target_deleted !== null)
            throw new RedirectError(409, "The target page is deleted.");
        }
        storage();
      }
      const item =
        operation === "delete"
          ? null
          : (results[2]?.results[0] as unknown as RedirectEntry | undefined);
      if (operation !== "delete" && !item) storage();
      return { language: locale, version: currentVersion, item: item ?? null };
    } catch (error) {
      this.failure(error);
    }
  }
}
