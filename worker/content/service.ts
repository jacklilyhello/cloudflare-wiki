import {
  CONTENT_LIMITS,
  type AdminTranslation,
  type ContentEventType,
  type ContentRevision,
  type CreateTranslationInput,
  type DraftInput,
  type RevisionSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import { MarkdownLimitError, renderMarkdown } from "../../shared/markdown";
import { indexSearchText, markdownText } from "../../shared/search";

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
  readonly status: 400 | 404 | 409 | 412;
  constructor(status: 400 | 404 | 409 | 412, message: string) {
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
  const path = boundedText(value, CONTENT_LIMITS.path, "page path", true);
  if (
    path !== value ||
    path !== path.normalize("NFKC") ||
    path !== path.toLowerCase() ||
    !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(path)
  )
    throw new ContentError(400, "Invalid page path.");
  // These are application routes, never public article paths.
  if (
    [
      "search",
      "admin",
      "api",
      "assets",
      "health",
      "robots.txt",
      "sitemap.xml",
    ].includes(path.split("/")[0] ?? "")
  )
    throw new ContentError(400, "This page path is reserved.");
  return path;
}
function changeNote(value: unknown = "") {
  return boundedText(value, CONTENT_LIMITS.changeNote, "change note");
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

// This service has no HTTP entry point. Its caller must establish administrator
// authorization before exposing these operations in a later slice.
export class ContentService {
  private readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  private statement(sql: string, values: SqlValue[] = []) {
    return this.db.prepare(sql).bind(...values);
  }
  private guard(
    id: string,
    version: number,
    deleted = false,
    draftId?: string,
  ): Guard {
    return {
      sql: `SELECT t.id FROM page_translations t WHERE t.id=? AND t.write_version=? AND t.deleted_at IS ${deleted ? "NOT " : ""}NULL${draftId ? " AND t.draft_revision_id=?" : ""}`,
      values: draftId ? [id, version, draftId] : [id, version],
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
    if (last?.meta.changes !== 1 || !row)
      throw new ContentError(
        412,
        "The content changed. Reload before retrying.",
      );
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
    if (!input || !["zh", "en"].includes(input.language))
      throw new ContentError(400, "Invalid content language.");
    const path = validateContentPath(input.path);
    const value = await validateDraft(input, input.language);
    const pageId =
      input.pageId === undefined
        ? crypto.randomUUID()
        : identifier(input.pageId);
    if (
      input.pageId !== undefined &&
      !(await this.statement("SELECT id FROM pages WHERE id=?", [
        pageId,
      ]).first())
    )
      throw new ContentError(404, "Page identity not found.");
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const guard = this.guard(id, 0);
    const statements: D1PreparedStatement[] = [];
    if (input.pageId === undefined)
      statements.push(
        this.statement("INSERT INTO pages(id,created_at) VALUES(?,?)", [
          pageId,
          now,
        ]),
      );
    statements.push(
      this.statement(
        "INSERT INTO page_translations(id,page_id,language,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        [id, pageId, input.language, path, now, now],
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
    const row = await this.statement(
      "SELECT * FROM page_translations WHERE id=?",
      [identifier(id)],
    ).first<TranslationRow>();
    if (!row) throw new ContentError(404, "Page translation not found.");
    return translation(row);
  }
  async getRevision(id: string, revisionId: string): Promise<ContentRevision> {
    const row = await this.statement(
      "SELECT * FROM page_revisions WHERE translation_id=? AND id=?",
      [identifier(id), identifier(revisionId)],
    ).first<RevisionRow>();
    if (!row) throw new ContentError(404, "Revision not found.");
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
    const result = await this.statement(
      `SELECT id,translation_id,revision_no,title,description,tags_json,change_note,restored_from_revision_id,created_at FROM page_revisions WHERE translation_id=?${beforeRevision === undefined ? "" : " AND revision_no<?"} ORDER BY revision_no DESC LIMIT ?`,
      beforeRevision === undefined ? [id, limit] : [id, beforeRevision, limit],
    ).all<Omit<RevisionRow, "markdown">>();
    return result.results.map((row) => {
      const { markdown: _markdown, ...summary } = revision({
        ...row,
        markdown: "",
      });
      return summary;
    });
  }
}
