import {
  type AdminTranslation,
  CONTENT_LIMITS,
  type PageSummary,
} from "../../shared/content";
import type { Language } from "../../shared/contracts";
import {
  DIRECTORY_LIMITS,
  type DirectoryMoveCommit,
  type DirectoryMoveInput,
  type DirectoryMovePreview,
  type DirectoryMoveResult,
  type PageDirectory,
  type PageDirectoryOptions,
} from "../../shared/directories";
import { indexSearchText } from "../../shared/search";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";
import { ContentError, validateContentPath } from "./service";

type SqlValue = string | number | null;
type Session = ReturnType<typeof sessionGuard>;
type Row = {
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
  title: string;
  description: string;
  tags_json: string;
};
type Registry = { version: number | null; move_token: string | null };
type ChildRow = Row & {
  child_path: string;
  segment: string;
  has_children: number;
};
type Cursor = { version: number; after: string };
type Plan = {
  id: string;
  version: number;
  fromPath: string;
  toPath: string;
  eventId: string;
  searchPath: string;
};

const metadata = `t.*,d.title,d.description,d.tags_json`;
const draftJoin = `LEFT JOIN page_revisions d ON d.id=t.draft_revision_id AND d.translation_id=t.id`;
// Binary prefix ranges include only slash-separated descendants; '_' is literal.
const subtree = (column: string) =>
  `(${column}=? OR (${column}>=? AND ${column}<?))`;
const prefixValues = (path: string): SqlValue[] => [
  path,
  `${path}/`,
  `${path}0`,
];
const planCte = `WITH plan AS (SELECT json_extract(value,'$.id') AS id,
  json_extract(value,'$.version') AS version,json_extract(value,'$.fromPath') AS from_path,
  json_extract(value,'$.toPath') AS to_path,json_extract(value,'$.eventId') AS event_id,
  json_extract(value,'$.searchPath') AS search_path FROM json_each(?))`;

function invalid(message = "Invalid directory input."): never {
  throw new ContentError(400, message);
}
function stale(): never {
  throw new ContentError(
    412,
    "The directory or its pages changed. Reload before retrying.",
  );
}
function storage(): never {
  throw new Error("Directory storage is temporarily unavailable.");
}
function conflict(): never {
  throw new ContentError(
    409,
    "The destination contains a reserved page path or alias.",
  );
}
function language(value: Language): Language {
  if (value !== "zh" && value !== "en") invalid("Invalid content language.");
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid("Invalid content version.");
  return value;
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  )
    invalid("Invalid content identifier.");
  return value;
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}
function inputPaths(input: DirectoryMoveInput) {
  const fromPath = validateContentPath(input.fromPath);
  const toPath = validateContentPath(input.toPath);
  if (
    fromPath === toPath ||
    fromPath.startsWith(`${toPath}/`) ||
    toPath.startsWith(`${fromPath}/`)
  )
    invalid("Source and destination directories must not overlap.");
  return { fromPath, toPath };
}
function translation(row: Row): AdminTranslation {
  try {
    identifier(row.id);
    identifier(row.page_id);
    language(row.language);
    validateContentPath(row.slug);
    version(row.write_version);
    version(row.revision_seq);
    identifier(row.draft_revision_id);
    if (row.published_revision_id !== null)
      identifier(row.published_revision_id);
    if (
      (row.published_revision_id === null) !== (row.published_at === null) ||
      row.deleted_at !== null
    )
      storage();
    for (const value of [row.created_at, row.updated_at, row.published_at]) {
      if (
        value !== null &&
        (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      )
        storage();
    }
  } catch {
    storage();
  }
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
function summary(row: Row): PageSummary {
  const page = translation(row);
  try {
    const tags: unknown = JSON.parse(row.tags_json);
    if (
      typeof row.title !== "string" ||
      !row.title ||
      row.title.length > CONTENT_LIMITS.title ||
      typeof row.description !== "string" ||
      row.description.length > CONTENT_LIMITS.description ||
      !Array.isArray(tags) ||
      tags.length > CONTENT_LIMITS.tags ||
      tags.some(
        (tag) => typeof tag !== "string" || tag.length > CONTENT_LIMITS.tag,
      )
    )
      storage();
    return {
      ...page,
      title: row.title,
      description: row.description,
      tags: tags as string[],
    };
  } catch {
    storage();
  }
}
function encode(cursor: Cursor, locale: Language, path: string): string {
  return btoa(
    String.fromCharCode(
      ...new TextEncoder().encode(
        JSON.stringify({ v: 1, language: locale, path, ...cursor }),
      ),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: unknown, locale: Language, path: string): Cursor | null {
  if (value === undefined) return null;
  try {
    if (
      typeof value !== "string" ||
      value.length > DIRECTORY_LIMITS.cursor ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      invalid();
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(
          atob(value.replace(/-/g, "+").replace(/_/g, "/")),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    if (typeof parsed.after !== "string" || parsed.after.includes("/"))
      invalid();
    validateContentPath(path ? `${path}/${parsed.after}` : parsed.after);
    const cursor = { version: version(parsed.version), after: parsed.after };
    if (encode(cursor, locale, path) !== value) invalid();
    return cursor;
  } catch {
    invalid("Invalid directory cursor.");
  }
}

export class PageDirectoryService {
  private readonly access: ContentWriteAccess;
  constructor(
    private readonly db: D1Database,
    access: ContentWriteAccess,
  ) {
    this.access = Object.freeze({ ...access });
    this.session();
  }
  private session(): Session {
    try {
      return sessionGuard(this.access);
    } catch {
      throw new ContentError(401, "Authentication required.");
    }
  }
  private statement(sql: string, values: SqlValue[] = []) {
    try {
      return this.db.prepare(sql).bind(...values);
    } catch {
      storage();
    }
  }
  private async batch(statements: D1PreparedStatement[]) {
    try {
      return await this.db.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        /UNIQUE constraint failed: (page_routes|page_translations)\./.test(
          message,
        )
      )
        conflict();
      storage();
    }
  }
  private registry(locale: Language, session: Session) {
    return this.statement(
      `SELECT r.version,r.move_token FROM (SELECT 1) LEFT JOIN route_registries r ON r.language=? WHERE ${session.sql}`,
      [locale, ...session.values],
    );
  }
  private readRegistry(row: Registry | undefined): number {
    if (!row) throw new ContentError(401, "Authentication required.");
    if (
      !Number.isSafeInteger(row.version) ||
      Number(row.version) < 1 ||
      row.move_token !== null
    )
      storage();
    return Number(row.version);
  }
  async list(
    locale: Language,
    options: PageDirectoryOptions = {},
  ): Promise<PageDirectory> {
    language(locale);
    object(options, [], ["path", "cursor", "limit"]);
    const path =
      options.path === undefined || options.path === ""
        ? ""
        : validateContentPath(options.path);
    const limit =
      options.limit === undefined
        ? DIRECTORY_LIMITS.defaultPage
        : options.limit;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DIRECTORY_LIMITS.page
    )
      invalid("Invalid directory page size.");
    const cursor = decode(options.cursor, locale, path);
    const session = this.session();
    const descendants = path ? `t.slug>=? AND t.slug<?` : "1";
    const tail = path ? "substr(t.slug,length(?)+2)" : "t.slug";
    const values: SqlValue[] = [
      ...(path ? [path] : []),
      locale,
      ...(path ? [`${path}/`, `${path}0`] : []),
      ...session.values,
    ];
    const childPath = path ? "?||'/'||n.segment" : "n.segment";
    if (path) values.push(path);
    values.push(locale, cursor?.after ?? "", limit + 1);
    const results = await this.batch([
      this.statement(
        `SELECT r.version,r.move_token,EXISTS(SELECT 1 FROM page_translations t WHERE t.language=? AND t.deleted_at IS NULL AND ${subtree("t.slug")}) AS directory_exists FROM (SELECT 1) LEFT JOIN route_registries r ON r.language=? WHERE ${session.sql}`,
        [locale, ...prefixValues(path), locale, ...session.values],
      ),
      this.statement(
        `SELECT ${metadata} FROM page_translations t ${draftJoin} WHERE t.language=? AND t.slug=? AND t.deleted_at IS NULL AND ${session.sql}`,
        [locale, path, ...session.values],
      ),
      this.statement(
        `WITH descendants AS (SELECT ${tail} AS tail FROM page_translations t WHERE t.language=? AND t.deleted_at IS NULL AND ${descendants} AND ${session.sql}),
        nodes AS (SELECT (CASE WHEN instr(tail,'/')=0 THEN tail ELSE substr(tail,1,instr(tail,'/')-1) END) AS segment,MAX(instr(tail,'/')>0) AS has_children FROM descendants GROUP BY segment),
        paths AS (SELECT n.*,${childPath} AS child_path FROM nodes n)
        SELECT p.child_path,p.segment,p.has_children,${metadata} FROM paths p
        LEFT JOIN page_translations t ON t.language=? AND t.slug=p.child_path AND t.deleted_at IS NULL ${draftJoin}
        WHERE p.segment>? ORDER BY p.segment LIMIT ?`,
        values,
      ),
    ]);
    const context = results[0]?.results[0] as
      | (Registry & { directory_exists: number })
      | undefined;
    const current = this.readRegistry(context);
    if (cursor && cursor.version !== current) stale();
    if (path && context?.directory_exists !== 1)
      throw new ContentError(404, "Directory not found.");
    const pageRow = results[1]?.results[0] as Row | undefined;
    const rows = results[2]?.results as unknown as ChildRow[];
    if (!Array.isArray(rows)) storage();
    const items = rows.slice(0, limit).map((row) => {
      try {
        validateContentPath(row.child_path);
        if (
          !row.segment ||
          row.segment.includes("/") ||
          row.child_path !== (path ? `${path}/${row.segment}` : row.segment) ||
          ![0, 1].includes(row.has_children)
        )
          storage();
      } catch {
        storage();
      }
      return {
        path: row.child_path,
        segment: row.segment,
        hasChildren: row.has_children === 1,
        page: row.id === null ? null : summary(row),
      };
    });
    const last = items.at(-1);
    return {
      language: locale,
      path,
      version: current,
      page: pageRow ? summary(pageRow) : null,
      items,
      nextCursor:
        rows.length > limit && last
          ? encode({ version: current, after: last.segment }, locale, path)
          : null,
    };
  }
  private async snapshot(locale: Language, fromPath: string, toPath: string) {
    const session = this.session();
    const results = await this.batch([
      this.registry(locale, session),
      this.statement(
        `SELECT ${metadata} FROM page_translations t ${draftJoin} WHERE t.language=? AND t.deleted_at IS NULL AND ${subtree("t.slug")} AND ${session.sql} ORDER BY t.slug LIMIT ?`,
        [
          locale,
          ...prefixValues(fromPath),
          ...session.values,
          DIRECTORY_LIMITS.move + 1,
        ],
      ),
      this.statement(
        `SELECT EXISTS(SELECT 1 FROM page_translations t WHERE t.language=? AND ${subtree("t.slug")}) OR EXISTS(SELECT 1 FROM page_routes r WHERE r.language=? AND ${subtree("r.path")}) AS occupied WHERE ${session.sql}`,
        [
          locale,
          ...prefixValues(toPath),
          locale,
          ...prefixValues(toPath),
          ...session.values,
        ],
      ),
    ]);
    const current = this.readRegistry(
      results[0]?.results[0] as Registry | undefined,
    );
    const rows = results[1]?.results as unknown as Row[];
    const target = results[2]?.results[0] as { occupied: number } | undefined;
    if (!Array.isArray(rows) || !target || ![0, 1].includes(target.occupied))
      storage();
    return { version: current, rows, occupied: Boolean(target.occupied) };
  }
  private members(rows: Row[], fromPath: string, toPath: string) {
    if (rows.length > DIRECTORY_LIMITS.move)
      throw new ContentError(
        409,
        "Move at most 25 pages at a time. Choose a smaller directory.",
      );
    return rows.map((row) => {
      const page = summary(row);
      const rewritten = validateContentPath(
        toPath + page.path.slice(fromPath.length),
      );
      return {
        id: page.id,
        version: page.version,
        fromPath: page.path,
        toPath: rewritten,
        title: page.title,
        published: page.publishedRevisionId !== null,
      };
    });
  }
  async preview(
    locale: Language,
    input: DirectoryMoveInput,
  ): Promise<DirectoryMovePreview> {
    language(locale);
    object(input, ["fromPath", "toPath"]);
    const paths = inputPaths(input);
    const state = await this.snapshot(locale, paths.fromPath, paths.toPath);
    if (!state.rows.length) throw new ContentError(404, "Directory not found.");
    const members = this.members(state.rows, paths.fromPath, paths.toPath);
    if (state.occupied) conflict();
    return {
      language: locale,
      ...paths,
      version: state.version,
      members,
      publishedCount: members.filter((member) => member.published).length,
    };
  }
  async move(
    locale: Language,
    input: DirectoryMoveCommit,
  ): Promise<DirectoryMoveResult> {
    language(locale);
    object(input, ["fromPath", "toPath", "expectedVersion", "expectedMembers"]);
    const paths = inputPaths(input);
    const expected = version(input.expectedVersion);
    if (
      !Array.isArray(input.expectedMembers) ||
      !input.expectedMembers.length ||
      input.expectedMembers.length > DIRECTORY_LIMITS.move
    )
      invalid("Invalid directory members.");
    const expectedMembers = new Map<string, number>();
    for (const member of input.expectedMembers) {
      object(member, ["id", "version"]);
      const id = identifier(member.id);
      if (expectedMembers.has(id)) invalid("Duplicate directory member.");
      expectedMembers.set(id, version(member.version));
    }
    const state = await this.snapshot(locale, paths.fromPath, paths.toPath);
    if (
      state.version !== expected ||
      state.rows.length !== expectedMembers.size ||
      state.rows.some(
        (row) => expectedMembers.get(row.id) !== row.write_version,
      )
    )
      stale();
    const members = this.members(state.rows, paths.fromPath, paths.toPath);
    if (state.occupied) conflict();
    const plan: Plan[] = members.map((member) => ({
      id: member.id,
      version: member.version,
      fromPath: member.fromPath,
      toPath: member.toPath,
      eventId: crypto.randomUUID(),
      searchPath: indexSearchText(member.toPath),
    }));
    const json = JSON.stringify(plan);
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const session = this.session();
    const claimed = `EXISTS(SELECT 1 FROM route_registries WHERE language=? AND move_token=?) AND ${session.sql}`;
    const guardValues: SqlValue[] = [locale, token, ...session.values];
    // The claim checks the entire active source set, not just known rows. A
    // concurrent create/restore/edit cannot silently join or escape the move.
    const claim = this.statement(
      `${planCte} UPDATE route_registries SET move_token=? WHERE language=? AND version=? AND move_token IS NULL AND ${session.sql}
      AND (SELECT count(*) FROM page_translations t WHERE t.language=? AND t.deleted_at IS NULL AND ${subtree("t.slug")})=?
      AND NOT EXISTS(SELECT 1 FROM plan p LEFT JOIN page_translations t ON t.id=p.id WHERE t.id IS NULL OR t.language IS NOT ? OR t.deleted_at IS NOT NULL OR t.slug IS NOT p.from_path OR t.write_version IS NOT p.version)
      AND NOT EXISTS(SELECT 1 FROM page_translations t WHERE t.language=? AND ${subtree("t.slug")})
      AND NOT EXISTS(SELECT 1 FROM page_routes r WHERE r.language=? AND ${subtree("r.path")}) RETURNING version`,
      [
        json,
        token,
        locale,
        expected,
        ...session.values,
        locale,
        ...prefixValues(paths.fromPath),
        plan.length,
        locale,
        locale,
        ...prefixValues(paths.toPath),
        locale,
        ...prefixValues(paths.toPath),
      ],
    );
    const results = await this.batch([
      claim,
      this.statement(
        `${planCte} INSERT INTO page_routes(language,path,translation_id,created_at) SELECT ?,p.to_path,p.id,? FROM plan p WHERE ${claimed}`,
        [json, locale, now, ...guardValues],
      ),
      this.statement(
        `${planCte} UPDATE published_search_fts SET path=(SELECT p.search_path FROM plan p WHERE p.id=published_search_fts.translation_id) WHERE translation_id IN(SELECT id FROM plan) AND ${claimed}`,
        [json, ...guardValues],
      ),
      this.statement(
        `${planCte} UPDATE published_search SET path=(SELECT p.to_path FROM plan p WHERE p.id=published_search.translation_id) WHERE translation_id IN(SELECT id FROM plan) AND ${claimed}`,
        [json, ...guardValues],
      ),
      this.statement(
        `${planCte} INSERT INTO page_events(id,translation_id,event_type,version,revision_id,from_path,to_path,change_note,created_at)
        SELECT p.event_id,t.id,'move',t.write_version+1,t.published_revision_id,t.slug,p.to_path,'',? FROM plan p JOIN page_translations t ON t.id=p.id WHERE ${claimed}`,
        [json, now, ...guardValues],
      ),
      this.statement(
        `${planCte} UPDATE page_translations SET slug=(SELECT p.to_path FROM plan p WHERE p.id=page_translations.id),write_version=write_version+1,updated_at=? WHERE id IN(SELECT id FROM plan) AND ${claimed} RETURNING *`,
        [json, now, ...guardValues],
      ),
      this.statement(
        // A trigger may silently IGNORE a row instead of throwing. Assert the
        // complete outcome inside the transaction: the empty token violates
        // its CHECK and rolls back all earlier writes if any member is absent.
        `${planCte} UPDATE route_registries SET move_token=(CASE WHEN ${session.sql}
          AND NOT EXISTS(SELECT 1 FROM plan p LEFT JOIN page_translations t ON t.id=p.id
            WHERE t.id IS NULL OR t.language IS NOT route_registries.language OR t.slug IS NOT p.to_path OR t.write_version IS NOT p.version+1 OR t.deleted_at IS NOT NULL
            OR NOT EXISTS(SELECT 1 FROM page_routes r WHERE r.language=t.language AND r.path=p.to_path AND r.translation_id=t.id)
            OR (t.published_revision_id IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM published_search s JOIN published_search_fts f ON f.rowid=s.rowid
              WHERE s.translation_id=t.id AND s.language=t.language AND s.revision_id=t.published_revision_id AND s.path=p.to_path
                AND f.translation_id=t.id AND f.language=t.language AND f.path=p.search_path))
            OR NOT EXISTS(SELECT 1 FROM page_events e JOIN audit_records a ON a.source_page_event_id=e.id
              WHERE e.id=p.event_id AND e.translation_id=t.id AND e.event_type='move' AND e.version=p.version+1
              AND e.from_path=p.from_path AND e.to_path=p.to_path AND e.revision_id IS t.published_revision_id
              AND a.category='page' AND a.action='page.move' AND a.subject_id=t.id AND a.subject_version=e.version))
          THEN NULL ELSE '' END) WHERE language=? AND move_token=? RETURNING version,move_token`,
        [json, ...session.values, locale, token],
      ),
      this.statement(
        `SELECT r.version,r.move_token,
        EXISTS(SELECT 1 FROM page_translations t WHERE t.language=? AND ${subtree("t.slug")}) OR
        EXISTS(SELECT 1 FROM page_routes a WHERE a.language=? AND ${subtree("a.path")}) AS occupied
        FROM (SELECT 1) LEFT JOIN route_registries r ON r.language=? WHERE ${session.sql}`,
        [
          locale,
          ...prefixValues(paths.toPath),
          locale,
          ...prefixValues(paths.toPath),
          locale,
          ...session.values,
        ],
      ),
    ]);
    const context = results[7]?.results[0] as
      | (Registry & { occupied: number })
      | undefined;
    const current = this.readRegistry(context);
    if (!results[0]?.results.length) {
      if (current !== expected) stale();
      if (context?.occupied === 1) conflict();
      stale();
    }
    if (
      results[6]?.results.length !== 1 ||
      results[5]?.results.length !== plan.length
    )
      storage();
    const items = (results[5].results as unknown as Row[])
      .map(translation)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { language: locale, ...paths, version: current, items };
  }
}
