import {
  type AdminTranslation,
  CONTENT_LIMITS,
  type ContentDetail,
  type ContentEvent,
  type ContentEventType,
  type ContentPage,
  type ContentPagination,
  type ContentRevision,
  type CreateTranslationInput,
  type DraftInput,
  type PageListOptions,
  type PageSummary,
  type RevisionSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { MarkdownLimitError, renderMarkdown } from "../../shared/markdown";
import { contentPathIssue, isContentPath } from "../../shared/page-path";
import { indexSearchText, markdownText } from "../../shared/search";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";

type SqlValue = string | number | null;
type Guard = { sql: string; values: SqlValue[] };
type TranslationRow = {
  id: string;
  page_id: string;
  language: Language;
  slug: string;
  write_version: number;
  revision_seq: number;
  draft_revision_id: string | null;
  published_revision_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  deleted_at: string | null;
};
type RevisionRow = {
  id: string;
  translation_id: string;
  revision_no: number;
  title: string;
  description: string;
  markdown: string;
  tags_json: string;
  change_note: string;
  restored_from_revision_id: string | null;
  created_at: string;
};

export class ContentError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 412;
  constructor(status: ContentError["status"], message: string) {
    super(message);
    this.name = "ContentError";
    this.status = status;
  }
}

function translation(row: TranslationRow): AdminTranslation {
  return {
    id: row.id,
    pageId: row.page_id,
    language: row.language,
    path: row.slug,
    version: row.write_version,
    revisionSeq: row.revision_seq,
    draftRevisionId: row.draft_revision_id,
    publishedRevisionId: row.published_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    deletedAt: row.deleted_at,
  };
}
function revision(row: RevisionRow): ContentRevision {
  return {
    id: row.id,
    translationId: row.translation_id,
    revisionNo: row.revision_no,
    title: row.title,
    description: row.description,
    markdown: row.markdown,
    tags: JSON.parse(row.tags_json) as string[],
    changeNote: row.change_note,
    restoredFromRevisionId: row.restored_from_revision_id,
    createdAt: row.created_at,
  };
}
function boundedText(
  value: unknown,
  max: number,
  label: string,
  required = false,
) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  ) {
    throw new ContentError(400, `Invalid ${label}.`);
  }
  return value.trim();
}
function identifier(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  )
    throw new ContentError(400, "Invalid content identifier.");
  return value;
}
export function validateContentPath(value: unknown): string {
  if (!isContentPath(value))
    throw new ContentError(
      400,
      contentPathIssue(value) === "reserved"
        ? "This page path is reserved."
        : "Invalid page path.",
    );
  return value;
}
function changeNote(value: unknown = "") {
  return boundedText(value, CONTENT_LIMITS.changeNote, "change note");
}
function pageLimit(value: number = CONTENT_LIMITS.revisionPage) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > CONTENT_LIMITS.revisionPage
  )
    throw new ContentError(400, "Invalid content pagination.");
  return value;
}
function decodeCursor(value: string): [string, string] {
  try {
    if (
      typeof value !== "string" ||
      value.length > 400 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      throw new Error();
    const parts: unknown = JSON.parse(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (
      !Array.isArray(parts) ||
      parts.length !== 2 ||
      typeof parts[0] !== "string" ||
      new Date(parts[0]).toISOString() !== parts[0]
    )
      throw new Error();
    return [parts[0], identifier(parts[1])];
  } catch {
    throw new ContentError(400, "Invalid content cursor.");
  }
}
function encodeCursor(item: PageSummary) {
  return btoa(JSON.stringify([item.updatedAt, item.id]))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
async function validateDraft(
  input: DraftInput,
  language: Language,
): Promise<Required<DraftInput>> {
  if (!input || typeof input !== "object")
    throw new ContentError(400, "Invalid draft.");
  const title = boundedText(input.title, CONTENT_LIMITS.title, "title", true);
  const description = boundedText(
    input.description,
    CONTENT_LIMITS.description,
    "description",
  );
  if (!Array.isArray(input.tags) || input.tags.length > CONTENT_LIMITS.tags)
    throw new ContentError(400, "Invalid tags.");
  const tags = [
    ...new Set(
      input.tags.map((tag) =>
        boundedText(tag, CONTENT_LIMITS.tag, "tag", true),
      ),
    ),
  ];
  if (typeof input.markdown !== "string")
    throw new ContentError(400, "Invalid Markdown.");
  try {
    await renderMarkdown(input.markdown, language);
  } catch (error) {
    if (error instanceof MarkdownLimitError)
      throw new ContentError(400, error.message);
    throw error;
  }
  return {
    title,
    description,
    markdown: input.markdown,
    tags,
    changeNote: changeNote(input.changeNote),
  };
}

// HTTP performs Origin/CSRF checks. Every SQL mutation independently checks the
// live session so an asynchronous render cannot outlive logout or credential changes.
export class ContentService {
  private readonly db: D1Database;
  private readonly access: ContentWriteAccess;
  constructor(db: D1Database, access: ContentWriteAccess) {
    this.db = db;
    this.access = Object.freeze({ ...access });
    this.session();
  }
  private session(): Guard {
    try {
      return sessionGuard(this.access);
    } catch {
      throw new ContentError(401, "Authentication required.");
    }
  }
  private async requireAccess() {
    const guard = this.session();
    if (
      !(await this.statement(
        `SELECT 1 WHERE ${guard.sql}`,
        guard.values,
      ).first())
    )
      throw new ContentError(401, "Authentication required.");
  }
  private statement(sql: string, values: SqlValue[] = []) {
    return this.db.prepare(sql).bind(...values);
  }
  private guard(
    id: string,
    version: number,
    deleted = false,
    draftId?: string,
    session: Guard = this.session(),
  ): Guard {
    return {
      sql: `SELECT t.id FROM page_translations t WHERE t.id=? AND t.write_version=? AND t.deleted_at IS ${deleted ? "NOT " : ""}NULL${draftId ? " AND t.draft_revision_id=?" : ""} AND ${session.sql}`,
      values: [
        ...(draftId ? [id, version, draftId] : [id, version]),
        ...session.values,
      ],
    };
  }
  private audit(
    guard: Guard,
    type: ContentEventType,
    now: string,
    revisionId: string | null,
    note = "",
    toPath: string | null = null,
  ) {
    return this.statement(
      `INSERT INTO page_events(id,translation_id,event_type,version,revision_id,from_path,to_path,change_note,created_at)
      SELECT ?,t.id,?,t.write_version+1,?,${type === "create" ? "NULL" : "t.slug"},?,?,? FROM page_translations t WHERE t.id IN (${guard.sql})`,
      [
        crypto.randomUUID(),
        type,
        revisionId,
        toPath,
        note,
        now,
        ...guard.values,
      ],
    );
  }
  private update(
    guard: Guard,
    now: string,
    assignments: string,
    values: SqlValue[],
  ) {
    return this.statement(
      `UPDATE page_translations SET ${assignments},write_version=write_version+1,updated_at=? WHERE id IN (${guard.sql}) RETURNING *`,
      [...values, now, ...guard.values],
    );
  }
  private async commit(
    statements: D1PreparedStatement[],
  ): Promise<AdminTranslation> {
    let results: D1Result<TranslationRow>[];
    try {
      results = await this.db.batch<TranslationRow>(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint|PRIMARY KEY constraint/i.test(message))
        throw new ContentError(
          409,
          "The page language or path is already in use.",
        );
      if (/FOREIGN KEY constraint|CHECK constraint/i.test(message))
        throw new ContentError(400, "Invalid content relationship or value.");
      throw new Error("Content storage operation failed.");
    }
    const last = results.at(-1);
    const row = last?.results[0];
    if (!row) {
      await this.requireAccess();
      throw new ContentError(
        412,
        "The content changed. Reload before retrying.",
      );
    }
    return translation(row);
  }
  private async current(id: string, expectedVersion: number, deleted = false) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw new ContentError(400, "Invalid content version.");
    const state = await this.getAdminTranslation(id);
    if (state.version !== expectedVersion)
      throw new ContentError(
        412,
        "The content changed. Reload before retrying.",
      );
    if (Boolean(state.deletedAt) !== deleted)
      throw new ContentError(
        400,
        deleted ? "The page is not deleted." : "The page is deleted.",
      );
    return state;
  }
  private insertRevision(
    guard: Guard,
    input: Required<DraftInput>,
    id: string,
    now: string,
    restoredFrom: string | null = null,
  ) {
    return this.statement(
      `INSERT INTO page_revisions(id,translation_id,revision_no,title,description,markdown,tags_json,change_note,restored_from_revision_id,created_at)
      SELECT ?,t.id,t.revision_seq+1,?,?,?,?,?,?,? FROM page_translations t WHERE t.id IN (${guard.sql})`,
      [
        id,
        input.title,
        input.description,
        input.markdown,
        JSON.stringify(input.tags),
        input.changeNote,
        restoredFrom,
        now,
        ...guard.values,
      ],
    );
  }
  private removeSearch(guard: Guard) {
    return [
      this.statement(
        `DELETE FROM published_search_fts WHERE rowid IN (SELECT rowid FROM published_search WHERE translation_id IN (${guard.sql}))`,
        guard.values,
      ),
      this.statement(
        `DELETE FROM published_search WHERE translation_id IN (${guard.sql})`,
        guard.values,
      ),
    ];
  }
  private replaceSearch(
    guard: Guard,
    language: Language,
    path: string,
    value: ContentRevision,
  ) {
    const body = markdownText(value.markdown);
    return [
      ...this.removeSearch(guard),
      this.statement(
        `INSERT INTO published_search(translation_id,language,revision_id,title,description,path,tags_json,body_text)
        SELECT t.id,?,?,?,?,?,?,? FROM page_translations t WHERE t.id IN (${guard.sql})`,
        [
          language,
          value.id,
          value.title,
          value.description,
          path,
          JSON.stringify(value.tags),
          body,
          ...guard.values,
        ],
      ),
      this.statement(
        `INSERT INTO published_search_fts(rowid,translation_id,language,title,tags,description,path,body)
        SELECT s.rowid,s.translation_id,s.language,?,?,?,?,? FROM published_search s WHERE s.translation_id IN (${guard.sql})`,
        [
          ...[
            value.title,
            value.tags.join(" "),
            value.description,
            path,
            body,
          ].map(indexSearchText),
          ...guard.values,
        ],
      ),
    ];
  }

  async createTranslation(
    input: CreateTranslationInput,
  ): Promise<AdminTranslation> {
    await this.requireAccess();
    if (!input || !["zh", "en"].includes(input.language))
      throw new ContentError(400, "Invalid content language.");
    const path = validateContentPath(input.path);
    const value = await validateDraft(input, input.language);
    const pageId =
      input.pageId === undefined
        ? crypto.randomUUID()
        : identifier(input.pageId);
    const lookupSession = this.session();
    if (
      input.pageId !== undefined &&
      !(await this.statement(
        `SELECT id FROM pages WHERE id=? AND ${lookupSession.sql}`,
        [pageId, ...lookupSession.values],
      ).first())
    ) {
      await this.requireAccess();
      throw new ContentError(404, "Page identity not found.");
    }
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const session = this.session();
    const guard = this.guard(id, 0, false, undefined, session);
    const statements: D1PreparedStatement[] = [];
    if (input.pageId === undefined)
      statements.push(
        this.statement(
          `INSERT INTO pages(id,created_at) SELECT ?,? WHERE ${session.sql}`,
          [pageId, now, ...session.values],
        ),
      );
    statements.push(
      this.statement(
        `INSERT INTO page_translations(id,page_id,language,slug,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE ${session.sql}`,
        [id, pageId, input.language, path, now, now, ...session.values],
      ),
      this.insertRevision(guard, value, revisionId, now),
      this.statement(
        `INSERT INTO page_routes(language,path,translation_id,created_at) SELECT language,slug,id,? FROM page_translations WHERE id IN (${guard.sql})`,
        [now, ...guard.values],
      ),
      this.audit(guard, "create", now, revisionId, value.changeNote, path),
      this.update(
        guard,
        now,
        "draft_revision_id=?,revision_seq=revision_seq+1",
        [revisionId],
      ),
    );
    return this.commit(statements);
  }
  async saveDraft(
    id: string,
    expectedVersion: number,
    input: DraftInput,
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion);
    const value = await validateDraft(input, state.language);
    return this.saveRevision(state, value, "save_draft");
  }
  private saveRevision(
    state: AdminTranslation,
    value: Required<DraftInput>,
    event: "save_draft" | "restore_revision",
    restoredFrom: string | null = null,
  ) {
    const guard = this.guard(state.id, state.version);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    return this.commit([
      this.insertRevision(guard, value, id, now, restoredFrom),
      this.audit(guard, event, now, id, value.changeNote),
      this.update(
        guard,
        now,
        "draft_revision_id=?,revision_seq=revision_seq+1",
        [id],
      ),
    ]);
  }
  async publish(
    id: string,
    expectedVersion: number,
    revisionId: string,
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion);
    identifier(revisionId);
    if (state.draftRevisionId !== revisionId)
      throw new ContentError(400, "Only the current draft can be published.");
    const value = await this.getRevision(id, revisionId);
    const guard = this.guard(id, expectedVersion, false, revisionId);
    const now = new Date().toISOString();
    return this.commit([
      ...this.replaceSearch(guard, state.language, state.path, value),
      this.audit(guard, "publish", now, revisionId),
      this.update(guard, now, "published_revision_id=?,published_at=?", [
        revisionId,
        now,
      ]),
    ]);
  }
  async unpublish(
    id: string,
    expectedVersion: number,
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion);
    const guard = this.guard(id, expectedVersion);
    const now = new Date().toISOString();
    return this.commit([
      ...this.removeSearch(guard),
      this.audit(guard, "unpublish", now, state.publishedRevisionId),
      this.update(
        guard,
        now,
        "published_revision_id=NULL,published_at=NULL",
        [],
      ),
    ]);
  }
  async move(
    id: string,
    expectedVersion: number,
    newPath: string,
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion);
    const path = validateContentPath(newPath);
    const guard = this.guard(id, expectedVersion);
    const now = new Date().toISOString();
    const statements = [
      this.statement(
        `INSERT INTO page_routes(language,path,translation_id,created_at)
      SELECT t.language,?,t.id,? FROM page_translations t WHERE t.id IN (${guard.sql}) AND NOT EXISTS(SELECT 1 FROM page_routes r WHERE r.language=t.language AND r.path=? AND r.translation_id=t.id)`,
        [path, now, ...guard.values, path],
      ),
    ];
    if (state.publishedRevisionId)
      statements.push(
        ...this.replaceSearch(
          guard,
          state.language,
          path,
          await this.getRevision(id, state.publishedRevisionId),
        ),
      );
    statements.push(
      this.audit(guard, "move", now, state.publishedRevisionId, "", path),
      this.update(guard, now, "slug=?", [path]),
    );
    return this.commit(statements);
  }
  async softDelete(
    id: string,
    expectedVersion: number,
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion);
    const guard = this.guard(id, expectedVersion);
    const now = new Date().toISOString();
    return this.commit([
      ...this.removeSearch(guard),
      this.audit(guard, "delete", now, state.publishedRevisionId),
      this.update(
        guard,
        now,
        "deleted_at=?,published_revision_id=NULL,published_at=NULL",
        [now],
      ),
    ]);
  }
  async restoreDeleted(
    id: string,
    expectedVersion: number,
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion, true);
    const guard = this.guard(id, expectedVersion, true);
    const now = new Date().toISOString();
    return this.commit([
      ...this.removeSearch(guard),
      this.audit(guard, "restore_deleted", now, state.draftRevisionId),
      this.update(
        guard,
        now,
        "deleted_at=NULL,published_revision_id=NULL,published_at=NULL",
        [],
      ),
    ]);
  }
  async restoreRevision(
    id: string,
    expectedVersion: number,
    revisionId: string,
    note = "",
  ): Promise<AdminTranslation> {
    const state = await this.current(id, expectedVersion);
    const source = await this.getRevision(id, revisionId);
    const value = await validateDraft(
      {
        title: source.title,
        description: source.description,
        markdown: source.markdown,
        tags: source.tags,
        changeNote: note,
      },
      state.language,
    );
    return this.saveRevision(state, value, "restore_revision", source.id);
  }
  async getAdminTranslation(id: string): Promise<AdminTranslation> {
    const guard = this.session();
    const row = await this.statement(
      `SELECT * FROM page_translations WHERE id=? AND ${guard.sql}`,
      [identifier(id), ...guard.values],
    ).first<TranslationRow>();
    if (!row) {
      await this.requireAccess();
      throw new ContentError(404, "Page translation not found.");
    }
    return translation(row);
  }
  async list(options: PageListOptions = {}): Promise<ContentPage<PageSummary>> {
    const limit = pageLimit(options.limit);
    const status = options.status ?? "active";
    if (
      !["active", "draft", "published", "deleted"].includes(status) ||
      (options.language !== undefined &&
        !["zh", "en"].includes(options.language))
    )
      throw new ContentError(400, "Invalid page filter.");
    const query =
      options.q === undefined
        ? ""
        : boundedText(options.q, CONTENT_LIMITS.query, "page query")
            .normalize("NFKC")
            .toLowerCase();
    const guard = this.session();
    const filters = [
      guard.sql,
      status === "deleted"
        ? "t.deleted_at IS NOT NULL"
        : "t.deleted_at IS NULL",
    ];
    const values = [...guard.values];
    if (status === "draft")
      filters.push(
        "(t.published_revision_id IS NULL OR t.draft_revision_id != t.published_revision_id)",
      );
    if (status === "published")
      filters.push("t.published_revision_id IS NOT NULL");
    if (options.language !== undefined) {
      filters.push("t.language=?");
      values.push(options.language);
    }
    if (query) {
      filters.push("(instr(lower(r.title),?)>0 OR instr(lower(t.slug),?)>0)");
      values.push(query, query);
    }
    if (options.cursor !== undefined) {
      const [date, id] = decodeCursor(options.cursor);
      filters.push("(t.updated_at<? OR (t.updated_at=? AND t.id>?))");
      values.push(date, date, id);
    }
    const rows = await this.statement(
      `SELECT t.*,r.title,r.description,r.tags_json FROM page_translations t JOIN page_revisions r ON r.translation_id=t.id AND r.id=t.draft_revision_id WHERE ${filters.join(" AND ")} ORDER BY t.updated_at DESC,t.id LIMIT ?`,
      [...values, limit + 1],
    ).all<
      TranslationRow & Pick<RevisionRow, "title" | "description" | "tags_json">
    >();
    if (!rows.results.length) await this.requireAccess();
    const items = rows.results.slice(0, limit).map((row) => ({
      ...translation(row),
      title: row.title,
      description: row.description,
      tags: JSON.parse(row.tags_json) as string[],
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.results.length > limit && last ? encodeCursor(last) : null,
    };
  }
  async getDetail(id: string): Promise<ContentDetail> {
    const state = await this.getAdminTranslation(id);
    const guard = this.session();
    const [draftResult, publishedResult, relatedResult] = await this.db.batch([
      this.statement(
        `SELECT * FROM page_revisions WHERE translation_id=? AND id=? AND ${guard.sql}`,
        [id, state.draftRevisionId, ...guard.values],
      ),
      this.statement(
        `SELECT * FROM page_revisions WHERE translation_id=? AND id=? AND ${guard.sql}`,
        [id, state.publishedRevisionId, ...guard.values],
      ),
      this.statement(
        `SELECT * FROM page_translations WHERE page_id=? AND ${guard.sql} ORDER BY language`,
        [state.pageId, ...guard.values],
      ),
    ]);
    const draft = draftResult?.results[0] as RevisionRow | undefined;
    if (!draft) {
      await this.requireAccess();
      throw new Error("Content storage operation failed.");
    }
    const published = publishedResult?.results[0] as RevisionRow | undefined;
    if (state.publishedRevisionId && !published)
      throw new Error("Content storage operation failed.");
    return {
      translation: state,
      draft: revision(draft),
      published: published ? revision(published) : null,
      translations: ((relatedResult?.results ?? []) as TranslationRow[]).map(
        translation,
      ),
    };
  }
  async listEvents(
    id: string,
    options: ContentPagination = {},
  ): Promise<ContentPage<ContentEvent>> {
    await this.getAdminTranslation(id);
    const limit = pageLimit(options.limit);
    const cursor = options.cursor;
    if (
      cursor !== undefined &&
      (!/^[1-9][0-9]{0,15}$/.test(cursor) ||
        !Number.isSafeInteger(Number(cursor)))
    )
      throw new ContentError(400, "Invalid event cursor.");
    const guard = this.session();
    const rows = await this.statement(
      `SELECT * FROM page_events WHERE translation_id=? AND ${guard.sql}${cursor === undefined ? "" : " AND version<?"} ORDER BY version DESC LIMIT ?`,
      [
        id,
        ...guard.values,
        ...(cursor === undefined ? [] : [Number(cursor)]),
        limit + 1,
      ],
    ).all<{
      id: string;
      translation_id: string;
      event_type: ContentEventType;
      version: number;
      revision_id: string | null;
      from_path: string | null;
      to_path: string | null;
      change_note: string;
      created_at: string;
    }>();
    if (!rows.results.length) await this.requireAccess();
    const items = rows.results.slice(0, limit).map((row) => ({
      id: row.id,
      translationId: row.translation_id,
      type: row.event_type,
      version: row.version,
      revisionId: row.revision_id,
      fromPath: row.from_path,
      toPath: row.to_path,
      changeNote: row.change_note,
      createdAt: row.created_at,
    }));
    return {
      items,
      nextCursor:
        rows.results.length > limit ? String(items.at(-1)?.version) : null,
    };
  }
  async getRevision(id: string, revisionId: string): Promise<ContentRevision> {
    const guard = this.session();
    const row = await this.statement(
      `SELECT * FROM page_revisions WHERE translation_id=? AND id=? AND ${guard.sql}`,
      [identifier(id), identifier(revisionId), ...guard.values],
    ).first<RevisionRow>();
    if (!row) {
      await this.requireAccess();
      throw new ContentError(404, "Revision not found.");
    }
    return revision(row);
  }
  async listRevisions(
    id: string,
    beforeRevision?: number,
    limit: number = CONTENT_LIMITS.revisionPage,
  ): Promise<RevisionSummary[]> {
    await this.getAdminTranslation(id);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > CONTENT_LIMITS.revisionPage ||
      (beforeRevision !== undefined &&
        (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1))
    )
      throw new ContentError(400, "Invalid revision pagination.");
    const guard = this.session();
    const result = await this.statement(
      `SELECT id,translation_id,revision_no,title,description,tags_json,change_note,restored_from_revision_id,created_at FROM page_revisions WHERE translation_id=?${beforeRevision === undefined ? "" : " AND revision_no<?"} AND ${guard.sql} ORDER BY revision_no DESC LIMIT ?`,
      [
        ...(beforeRevision === undefined ? [id] : [id, beforeRevision]),
        ...guard.values,
        limit,
      ],
    ).all<Omit<RevisionRow, "markdown">>();
    if (!result.results.length) await this.requireAccess();
    return result.results.map((row) => {
      const { markdown: _markdown, ...summary } = revision({
        ...row,
        markdown: "",
      });
      return summary;
    });
  }
}
