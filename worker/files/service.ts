import {
  type CreateFolderInput,
  FILE_LIMITS,
  FILE_MIMES,
  type FileAltInput,
  type FileEntry,
  type FileListOptions,
  type FileMime,
  type FilePage,
  type FileRole,
  type MoveFileInput,
  type ObjectInfo,
  type ObjectInput,
  type PrepareUploadInput,
  type RenameFileInput,
} from "../../shared/files";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";
import {
  FilesError,
  type ObjectReceipt,
  type StoredFileObject,
  type UploadDescriptor,
} from "./contracts";

export { FilesError } from "./contracts";

type Value = string | number | null;
type Row = {
  id: string;
  parent_id: string | null;
  kind: "file" | "folder";
  name: string;
  name_key: string;
  version: number;
  state: FileEntry["state"];
  thumbnail_state: FileEntry["thumbnailState"];
  alt_zh: string;
  alt_en: string;
  source_object_id: string | null;
  thumbnail_object_id: string | null;
  upload_auth_version: number | null;
  upload_expires_at: string | null;
  published_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  objects_json: string;
};
type ObjectRow = {
  id: string;
  file_id: string;
  role: FileRole;
  object_key: string;
  receipt_token: string;
  expected_bytes: number;
  expected_sha256: string;
  mime_hint: FileMime;
  verified_at: string | null;
  r2_version: string | null;
  mime: FileMime | null;
  width: number | null;
  height: number | null;
};
type Context = { row: Row; entry: FileEntry; objects: ObjectRow[] };
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const controls = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;
const columns = `e.*,coalesce((SELECT json_group_array(json_object(
  'id',o.id,'file_id',o.file_id,'role',o.role,'object_key',o.object_key,'receipt_token',o.receipt_token,
  'expected_bytes',o.expected_bytes,'expected_sha256',o.expected_sha256,'mime_hint',o.mime_hint,
  'verified_at',o.verified_at,'r2_version',o.r2_version,'mime',o.mime,'width',o.width,'height',o.height
)) FROM file_objects o WHERE o.file_id=e.id),'[]') AS objects_json`;
function invalid(message = "Invalid file input."): never {
  throw new FilesError(400, message);
}
function storage(): never {
  throw new FilesError(503, "File storage is temporarily unavailable.");
}
function conflict(
  message = "The file cannot be changed in its current state.",
): never {
  throw new FilesError(409, message);
}
function stale(): never {
  throw new FilesError(
    412,
    "The file library changed. Reload before retrying.",
  );
}
function missing(): never {
  throw new FilesError(404, "File not found.");
}
function unauthorized(): never {
  throw new FilesError(401, "Authentication required.");
}
function failure(error: unknown): never {
  if (error instanceof FilesError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (
    /files_(parent|depth|name|not_empty|state|private_restore)|UNIQUE constraint/.test(
      message,
    )
  )
    conflict(
      "The destination is unavailable, occupied or outside the folder limits.",
    );
  storage();
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    invalid("Invalid file identifier.");
  return value;
}
function parent(value: unknown): string | null {
  return value === null ? null : id(value);
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid("Invalid file version.");
  return value;
}
function role(value: unknown): FileRole {
  if (value !== "source" && value !== "thumbnail") invalid();
  return value;
}
function text(value: unknown, limit: number, nonempty = false): string {
  if (typeof value !== "string" || controls.test(value)) invalid();
  const normalized = value.normalize("NFC").trim();
  if (normalized.length > limit || (nonempty && !normalized.length)) invalid();
  return normalized;
}
function name(value: unknown): string {
  const result = text(value, FILE_LIMITS.name, true);
  if (
    /[\\/]/.test(result) ||
    result === "." ||
    result === ".." ||
    key(result).length > 1000
  )
    invalid("Invalid file name.");
  return result;
}
function key(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  )
    invalid();
  return value;
}
function objectInput(value: unknown, selectedRole: FileRole): ObjectInput {
  const raw = object(value, ["bytes", "sha256", "mimeHint"]);
  if (
    typeof raw.bytes !== "number" ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes < 1 ||
    raw.bytes >
      (selectedRole === "source"
        ? FILE_LIMITS.sourceBytes
        : FILE_LIMITS.thumbnailBytes) ||
    typeof raw.sha256 !== "string" ||
    !digest.test(raw.sha256) ||
    !FILE_MIMES.includes(raw.mimeHint as FileMime)
  )
    invalid();
  if (
    (selectedRole === "thumbnail" &&
      raw.mimeHint === "application/octet-stream") ||
    (raw.mimeHint !== "application/octet-stream" &&
      raw.bytes > FILE_LIMITS.imageBytes)
  )
    invalid();
  return raw as unknown as ObjectInput;
}
function info(o: ObjectRow): ObjectInfo | null {
  if (o.verified_at === null) {
    if ([o.r2_version, o.mime, o.width, o.height].some((v) => v !== null))
      storage();
    return null;
  }
  date(o.verified_at);
  if (
    typeof o.r2_version !== "string" ||
    !o.r2_version.length ||
    o.r2_version.length > 256 ||
    controls.test(o.r2_version) ||
    !FILE_MIMES.includes(o.mime as FileMime) ||
    o.mime !== o.mime_hint
  )
    storage();
  if (o.mime === "application/octet-stream") {
    if (o.role !== "source" || o.width !== null || o.height !== null) storage();
  } else if (
    o.mime_hint === "application/octet-stream" ||
    !Number.isSafeInteger(o.width) ||
    !Number.isSafeInteger(o.height) ||
    (o.width ?? 0) < 1 ||
    (o.height ?? 0) < 1 ||
    (o.width ?? Infinity) * (o.height ?? Infinity) > FILE_LIMITS.imagePixels ||
    (o.role === "thumbnail" &&
      ((o.width ?? Infinity) > FILE_LIMITS.thumbnailEdge ||
        (o.height ?? Infinity) > FILE_LIMITS.thumbnailEdge))
  )
    storage();
  return {
    bytes: o.expected_bytes,
    mime: o.mime as FileMime,
    width: o.width,
    height: o.height,
  };
}
function decode(row: Row): Context {
  try {
    id(row.id);
    parent(row.parent_id);
    version(row.version);
    if (
      row.name !== name(row.name) ||
      row.name_key !== key(row.name) ||
      row.alt_zh !== text(row.alt_zh, FILE_LIMITS.alt) ||
      row.alt_en !== text(row.alt_en, FILE_LIMITS.alt)
    )
      storage();
    date(row.created_at);
    date(row.updated_at);
    if (row.deleted_at !== null) date(row.deleted_at);
    if (row.published_at !== null) date(row.published_at);
    if (
      !["file", "folder"].includes(row.kind) ||
      !["pending", "ready", "abandoned"].includes(row.state) ||
      !["none", "pending", "ready", "abandoned"].includes(row.thumbnail_state)
    )
      storage();
    const objects: ObjectRow[] = JSON.parse(row.objects_json);
    if (!Array.isArray(objects) || objects.length > 2) storage();
    for (const o of objects) {
      id(o.id);
      role(o.role);
      if (
        o.file_id !== row.id ||
        o.object_key !== `files/${o.id}` ||
        !digest.test(o.receipt_token)
      )
        storage();
      objectInput(
        {
          bytes: o.expected_bytes,
          sha256: o.expected_sha256,
          mimeHint: o.mime_hint,
        },
        o.role,
      );
      info(o);
    }
    const source = objects.find((o) => o.role === "source");
    const thumb = objects.find((o) => o.role === "thumbnail");
    if (row.kind === "folder") {
      if (
        objects.length ||
        row.state !== "ready" ||
        row.thumbnail_state !== "none" ||
        row.source_object_id !== null ||
        row.thumbnail_object_id !== null ||
        row.upload_auth_version !== null ||
        row.upload_expires_at !== null ||
        row.published_at !== null ||
        row.alt_zh ||
        row.alt_en
      )
        storage();
    } else {
      version(row.upload_auth_version);
      date(row.upload_expires_at);
      if (
        !source ||
        source.id !== row.source_object_id ||
        objects.length !== (row.thumbnail_state === "none" ? 1 : 2) ||
        (row.thumbnail_state === "none"
          ? row.thumbnail_object_id !== null || thumb !== undefined
          : !thumb || thumb.id !== row.thumbnail_object_id)
      )
        storage();
      if (
        (row.state === "ready") !== (source.verified_at !== null) ||
        (row.thumbnail_state === "ready") !== (thumb?.verified_at != null)
      )
        storage();
      if (
        row.thumbnail_state === "ready" &&
        (row.state !== "ready" || source.mime === "application/octet-stream")
      )
        storage();
    }
    if (
      (row.deleted_at !== null &&
        (row.state !== "ready" ||
          row.published_at !== null ||
          row.thumbnail_state === "pending")) ||
      (row.published_at !== null &&
        (row.kind !== "file" ||
          row.state !== "ready" ||
          row.thumbnail_state === "pending")) ||
      (row.state === "abandoned" &&
        !["none", "abandoned"].includes(row.thumbnail_state))
    )
      storage();
    return {
      row,
      objects,
      entry: {
        id: row.id,
        kind: row.kind,
        parentId: row.parent_id,
        name: row.name,
        version: row.version,
        state: row.state,
        thumbnailState: row.thumbnail_state,
        alt: row.kind === "file" ? { zh: row.alt_zh, en: row.alt_en } : null,
        source: source ? info(source) : null,
        thumbnail: thumb ? info(thumb) : null,
        uploadExpiresAt: row.upload_expires_at,
        publishedAt: row.published_at,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    };
  } catch {
    storage();
  }
}
function descriptor(context: Context, o: ObjectRow): UploadDescriptor {
  return {
    fileId: context.row.id,
    objectId: o.id,
    role: o.role,
    objectKey: o.object_key,
    receiptToken: o.receipt_token,
    expectedBytes: o.expected_bytes,
    expectedSha256: o.expected_sha256,
    mimeHint: o.mime_hint,
    expiresAt: context.row.upload_expires_at as string,
    uploadAuthVersion: context.row.upload_auth_version as number,
    entryVersion: context.row.version,
  };
}
function receipt(context: Context, o: ObjectRow): ObjectReceipt {
  if (!o.verified_at || !o.mime || !o.r2_version) storage();
  return {
    fileId: context.row.id,
    objectId: o.id,
    role: o.role,
    objectKey: o.object_key,
    receiptToken: o.receipt_token,
    bytes: o.expected_bytes,
    sha256: o.expected_sha256,
    mime: o.mime,
    width: o.width,
    height: o.height,
    r2Version: o.r2_version,
  };
}
function stored(
  context: Context,
  selectedRole: FileRole,
): StoredFileObject | null {
  if (
    context.row.kind !== "file" ||
    context.row.state !== "ready" ||
    context.row.deleted_at !== null
  )
    return null;
  const o = context.objects.find((item) => item.role === selectedRole);
  if (
    !o?.verified_at ||
    (selectedRole === "thumbnail" && context.row.thumbnail_state !== "ready")
  )
    return null;
  return {
    entry: context.entry,
    descriptor: descriptor(context, o),
    receipt: receipt(context, o),
  };
}
export async function getPublicFileObject(
  db: D1Database,
  fileId: string,
  selectedRole: FileRole,
): Promise<StoredFileObject | null> {
  id(fileId);
  role(selectedRole);
  try {
    const row = await db
      .prepare(
        `SELECT ${columns} FROM file_entries e WHERE e.id=? AND e.kind='file' AND e.state='ready' AND e.deleted_at IS NULL AND e.published_at IS NOT NULL`,
      )
      .bind(fileId)
      .first<Row>();
    return row ? stored(decode(row), selectedRole) : null;
  } catch (error) {
    failure(error);
  }
}
function encode(value: unknown): string {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class FilesService {
  private readonly access: ContentWriteAccess;
  constructor(
    private readonly db: D1Database,
    access: ContentWriteAccess,
  ) {
    this.access = Object.freeze({ ...access });
    this.session();
  }
  private session(now = Date.now()) {
    try {
      return sessionGuard(this.access, now);
    } catch {
      unauthorized();
    }
  }
  private statement(sql: string, values: Value[] = []) {
    try {
      return this.db.prepare(sql).bind(...values);
    } catch {
      storage();
    }
  }
  private contextStatement(
    fileId: string,
    session: ReturnType<typeof sessionGuard>,
  ) {
    return this.statement(
      `SELECT ${columns} FROM (SELECT 1) LEFT JOIN file_entries e ON e.id=? WHERE ${session.sql}`,
      [fileId, ...session.values],
    );
  }
  private contextRow(row: Row | undefined | null): Context {
    if (!row) unauthorized();
    if (row.id === null) missing();
    return decode(row);
  }
  private async context(fileId: string): Promise<Context> {
    id(fileId);
    try {
      return this.contextRow(
        await this.contextStatement(fileId, this.session()).first<Row>(),
      );
    } catch (error) {
      failure(error);
    }
  }
  async get(fileId: string): Promise<FileEntry> {
    return (await this.context(fileId)).entry;
  }
  private registry(session: ReturnType<typeof sessionGuard>) {
    return this.statement(
      `SELECT l.version FROM (SELECT 1) LEFT JOIN file_library l ON l.id=1 WHERE ${session.sql}`,
      session.values,
    );
  }
  private registryVersion(row: { version: number } | undefined): number {
    if (!row) unauthorized();
    try {
      return version(row.version);
    } catch {
      storage();
    }
  }
  async list(options: FileListOptions = {}): Promise<FilePage> {
    object(options, [], ["parentId", "state", "q", "cursor", "limit"]);
    const state = options.state ?? "active";
    if (state !== "active" && state !== "deleted") invalid();
    const parentId =
      options.parentId === undefined
        ? state === "deleted"
          ? "all"
          : null
        : parent(options.parentId);
    const q =
      options.q === undefined ? "" : key(text(options.q, FILE_LIMITS.query));
    if (q.length > FILE_LIMITS.query) invalid("Invalid file query.");
    const limit = options.limit ?? FILE_LIMITS.defaultPage;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_LIMITS.page)
      invalid();
    const scope = { state, parentId, q };
    let cursor: {
      version: number;
      name: string;
      id: string;
      scope: typeof scope;
    } | null = null;
    if (options.cursor !== undefined) {
      try {
        if (
          typeof options.cursor !== "string" ||
          options.cursor.length > FILE_LIMITS.cursor ||
          !/^[A-Za-z0-9_-]+$/.test(options.cursor)
        )
          invalid();
        cursor = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Uint8Array.from(
              atob(options.cursor.replace(/-/g, "+").replace(/_/g, "/")),
              (char) => char.charCodeAt(0),
            ),
          ),
        );
        if (
          !cursor ||
          typeof cursor.name !== "string" ||
          cursor.name.length > 1000 ||
          encode({
            version: version(cursor.version),
            name: cursor.name,
            id: id(cursor.id),
            scope,
          }) !== options.cursor
        )
          invalid();
      } catch {
        invalid("Invalid file cursor.");
      }
    }
    const session = this.session();
    const predicates = [
      session.sql,
      state === "active"
        ? "e.deleted_at IS NULL AND e.state<>'abandoned'"
        : "e.deleted_at IS NOT NULL AND e.state='ready'",
    ];
    const values: Value[] = [...session.values];
    if (parentId !== "all") {
      predicates.push("e.parent_id IS ?");
      values.push(parentId);
    }
    if (q) {
      predicates.push("instr(e.name_key,?)>0");
      values.push(q);
    }
    if (cursor) {
      predicates.push("(e.name_key>? OR (e.name_key=? AND e.id>?))");
      values.push(cursor.name, cursor.name, cursor.id);
    }
    values.push(limit + 1);
    try {
      const results = await this.db.batch([
        this.registry(session),
        this.statement(
          `SELECT ${columns} FROM file_entries e WHERE ${predicates.join(" AND ")} ORDER BY e.name_key,e.id LIMIT ?`,
          values,
        ),
      ]);
      const libraryVersion = this.registryVersion(
        results[0]?.results[0] as { version: number } | undefined,
      );
      if (cursor && cursor.version !== libraryVersion) stale();
      const rows = results[1]?.results as Row[];
      const items = rows.slice(0, limit).map((row) => decode(row).entry);
      const last = rows[limit - 1];
      return {
        libraryVersion,
        items,
        nextCursor:
          rows.length > limit && last
            ? encode({
                version: libraryVersion,
                name: last.name_key,
                id: last.id,
                scope,
              })
            : null,
      };
    } catch (error) {
      failure(error);
    }
  }
  private async create(
    input: CreateFolderInput | PrepareUploadInput,
    kind: "folder" | "file",
  ): Promise<FileEntry> {
    const raw = object(
      input,
      [
        "expectedLibraryVersion",
        "parentId",
        "name",
        ...(kind === "file" ? ["source"] : []),
      ],
      kind === "file" ? ["thumbnail"] : [],
    );
    const expected = version(raw.expectedLibraryVersion),
      parentId = parent(raw.parentId),
      filename = name(raw.name);
    const source = kind === "file" ? objectInput(raw.source, "source") : null;
    const thumb = Object.hasOwn(raw, "thumbnail")
      ? objectInput(raw.thumbnail, "thumbnail")
      : null;
    if (thumb && source?.mimeHint === "application/octet-stream") invalid();
    const fileId = crypto.randomUUID(),
      sourceId = source ? crypto.randomUUID() : null,
      thumbId = thumb ? crypto.randomUUID() : null;
    const now = Date.now(),
      timestamp = new Date(now).toISOString(),
      session = this.session(now);
    const statements = [
      this.statement(
        `INSERT INTO file_entries(id,parent_id,kind,name,name_key,version,state,thumbnail_state,source_object_id,thumbnail_object_id,upload_auth_version,upload_expires_at,created_at,updated_at)
      SELECT ?,?,?,?,?,1,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM file_library WHERE id=1 AND version=?) AND ${session.sql} RETURNING id`,
        [
          fileId,
          parentId,
          kind,
          filename,
          key(filename),
          kind === "folder" ? "ready" : "pending",
          thumb ? "pending" : "none",
          sourceId,
          thumbId,
          source ? this.access.authVersion : null,
          source ? new Date(now + FILE_LIMITS.uploadMs).toISOString() : null,
          timestamp,
          timestamp,
          expected,
          ...session.values,
        ],
      ),
    ];
    for (const [objectId, selectedRole, value] of [
      [sourceId, "source", source],
      [thumbId, "thumbnail", thumb],
    ] as const) {
      if (!objectId || !value) continue;
      const token = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      statements.push(
        this.statement(
          `INSERT INTO file_objects(id,file_id,role,object_key,receipt_token,expected_bytes,expected_sha256,mime_hint)
        SELECT ?,?,?,?,?,?,?,? FROM file_entries e WHERE e.id=? AND e.version=1 AND ${session.sql}`,
          [
            objectId,
            fileId,
            selectedRole,
            `files/${objectId}`,
            token,
            value.bytes,
            value.sha256,
            value.mimeHint,
            fileId,
            ...session.values,
          ],
        ),
      );
    }
    statements.push(
      this.registry(session),
      this.contextStatement(fileId, session),
    );
    try {
      const results = await this.db.batch(statements);
      const current = this.registryVersion(
        results.at(-2)?.results[0] as { version: number } | undefined,
      );
      if (!results[0]?.results.length) {
        if (current !== expected) stale();
        storage();
      }
      return this.contextRow(results.at(-1)?.results[0] as Row | undefined)
        .entry;
    } catch (error) {
      failure(error);
    }
  }
  createFolder(input: CreateFolderInput) {
    return this.create(input, "folder");
  }
  prepareUpload(input: PrepareUploadInput) {
    return this.create(input, "file");
  }
  private async mutate(
    fileId: string,
    expected: number,
    build: (current: Context, now: string) => Record<string, Value>,
  ): Promise<FileEntry> {
    version(expected);
    const current = await this.context(fileId);
    if (current.row.version !== expected) stale();
    const now = new Date().toISOString(),
      session = this.session();
    const changes = build(current, now);
    const fields = Object.keys(changes).filter(
      (field) => changes[field] !== current.row[field as keyof Row],
    );
    const statements = fields.length
      ? [
          this.statement(
            `UPDATE file_entries SET ${fields.map((field) => `${field}=?`).join(",")},version=version+1,updated_at=? WHERE id=? AND version=? AND ${session.sql} RETURNING id`,
            [
              ...fields.map((field) => changes[field] as Value),
              now,
              fileId,
              expected,
              ...session.values,
            ],
          ),
        ]
      : [];
    statements.push(this.contextStatement(fileId, session));
    try {
      const results = await this.db.batch(statements);
      const result = this.contextRow(
        results.at(-1)?.results[0] as Row | undefined,
      );
      if (
        (fields.length ? !results[0]?.results.length : true) &&
        result.row.version !== expected
      )
        stale();
      return result.entry;
    } catch (error) {
      failure(error);
    }
  }
  private ready(context: Context, deleted = false) {
    if (
      context.row.state !== "ready" ||
      (context.row.deleted_at !== null) !== deleted
    )
      conflict();
  }
  rename(fileId: string, input: RenameFileInput) {
    const raw = object(input, ["expectedVersion", "name"]),
      filename = name(raw.name);
    return this.mutate(fileId, version(raw.expectedVersion), (current) => {
      this.ready(current);
      return { name: filename, name_key: key(filename) };
    });
  }
  move(fileId: string, input: MoveFileInput) {
    const raw = object(input, ["expectedVersion", "parentId"]),
      parentId = parent(raw.parentId);
    return this.mutate(fileId, version(raw.expectedVersion), (current) => {
      this.ready(current);
      return { parent_id: parentId };
    });
  }
  updateAlt(fileId: string, input: FileAltInput) {
    const raw = object(input, ["expectedVersion", "alt"]),
      alt = object(raw.alt, ["zh", "en"]);
    const zh = text(alt.zh, FILE_LIMITS.alt),
      en = text(alt.en, FILE_LIMITS.alt);
    return this.mutate(fileId, version(raw.expectedVersion), (current) => {
      this.ready(current);
      if (current.row.kind !== "file") conflict();
      return { alt_zh: zh, alt_en: en };
    });
  }
  publish(fileId: string, expectedVersion: number) {
    return this.mutate(fileId, expectedVersion, (current, now) => {
      this.ready(current);
      if (current.row.kind !== "file") conflict();
      return {
        published_at: current.row.published_at ?? now,
        thumbnail_state:
          current.row.thumbnail_state === "pending"
            ? "abandoned"
            : current.row.thumbnail_state,
      };
    });
  }
  unpublish(fileId: string, expectedVersion: number) {
    return this.mutate(fileId, expectedVersion, (current) => {
      this.ready(current);
      if (current.row.kind !== "file") conflict();
      return { published_at: null };
    });
  }
  softDelete(fileId: string, expectedVersion: number) {
    return this.mutate(fileId, expectedVersion, (current, now) => {
      this.ready(current);
      return {
        deleted_at: now,
        published_at: null,
        thumbnail_state:
          current.row.thumbnail_state === "pending"
            ? "abandoned"
            : current.row.thumbnail_state,
      };
    });
  }
  restore(fileId: string, input: MoveFileInput) {
    const raw = object(input, ["expectedVersion", "parentId"]),
      parentId = parent(raw.parentId);
    return this.mutate(fileId, version(raw.expectedVersion), (current) => {
      this.ready(current, true);
      return { deleted_at: null, published_at: null, parent_id: parentId };
    });
  }
  abandon(fileId: string, expectedVersion: number) {
    return this.mutate(
      fileId,
      expectedVersion,
      (current): Record<string, Value> => {
        if (
          current.row.kind !== "file" ||
          current.row.deleted_at !== null ||
          current.row.published_at !== null
        )
          conflict();
        if (
          current.row.state === "abandoned" ||
          (current.row.state === "ready" &&
            current.row.thumbnail_state === "abandoned")
        )
          return {};
        if (current.row.state === "pending")
          return {
            state: "abandoned",
            thumbnail_state:
              current.row.thumbnail_state === "pending"
                ? "abandoned"
                : current.row.thumbnail_state,
          };
        if (current.row.thumbnail_state !== "pending") conflict();
        return { thumbnail_state: "abandoned" };
      },
    );
  }
  private upload(
    context: Context,
    selectedRole: FileRole,
    now: number,
  ): ObjectRow {
    if (
      context.row.kind !== "file" ||
      context.row.deleted_at !== null ||
      context.row.state === "abandoned"
    )
      conflict();
    const o = context.objects.find((item) => item.role === selectedRole);
    if (
      !o ||
      (selectedRole === "thumbnail" &&
        (context.row.state !== "ready" ||
          !["pending", "ready"].includes(context.row.thumbnail_state) ||
          context.entry.source?.mime === "application/octet-stream"))
    )
      conflict();
    // Completed receipts can be reconciled at the exact current version even
    // after the preparation window; this cannot write or revive an upload.
    if (o.verified_at !== null) return o;
    if (context.row.published_at !== null) conflict();
    if (context.row.upload_auth_version !== this.access.authVersion)
      conflict(
        "This upload belongs to an earlier credential version. Cancel it and start a new upload.",
      );
    if ((context.row.upload_expires_at ?? "") <= new Date(now).toISOString())
      conflict("The upload expired. Cancel it and start a new upload.");
    return o;
  }
  async authorizeUpload(
    fileId: string,
    selectedRole: FileRole,
    expectedVersion: number,
  ): Promise<UploadDescriptor> {
    role(selectedRole);
    version(expectedVersion);
    const current = await this.context(fileId);
    if (current.row.version !== expectedVersion) stale();
    return descriptor(current, this.upload(current, selectedRole, Date.now()));
  }
  async finishObject(
    value: ObjectReceipt,
    expectedVersion: number,
  ): Promise<FileEntry> {
    const raw = object(value, [
      "fileId",
      "objectId",
      "role",
      "objectKey",
      "receiptToken",
      "bytes",
      "sha256",
      "mime",
      "width",
      "height",
      "r2Version",
    ]);
    const fileId = id(raw.fileId),
      selectedRole = role(raw.role);
    version(expectedVersion);
    const current = await this.context(fileId);
    if (current.row.version !== expectedVersion) stale();
    const now = Date.now(),
      o = this.upload(current, selectedRole, now);
    if (
      raw.objectId !== o.id ||
      raw.objectKey !== o.object_key ||
      raw.receiptToken !== o.receipt_token ||
      raw.bytes !== o.expected_bytes ||
      raw.sha256 !== o.expected_sha256
    )
      conflict("The stored object does not match this upload.");
    const updated = {
      ...o,
      verified_at: new Date(now).toISOString(),
      r2_version: raw.r2Version,
      mime: raw.mime,
      width: raw.width,
      height: raw.height,
    } as ObjectRow;
    try {
      info(updated);
    } catch {
      invalid("Invalid file receipt.");
    }
    if (o.verified_at !== null) {
      if (
        Object.entries(receipt(current, o)).some(
          ([field, expected]) => raw[field] !== expected,
        )
      )
        conflict("The stored object does not match its completed receipt.");
      // Re-read in a batch so revocation or a concurrent metadata edit wins.
      return this.mutate(fileId, expectedVersion, () => ({}));
    }
    const session = this.session(now),
      timestamp = new Date(now).toISOString();
    const guard = `e.id=? AND e.version=? AND e.upload_auth_version=? AND e.upload_expires_at>? AND e.deleted_at IS NULL AND e.published_at IS NULL AND ${session.sql}`;
    const guardValues = [
      fileId,
      expectedVersion,
      this.access.authVersion,
      timestamp,
      ...session.values,
    ];
    try {
      const results = await this.db.batch([
        this.statement(
          `UPDATE file_objects SET verified_at=?,r2_version=?,mime=?,width=?,height=? WHERE id=? AND verified_at IS NULL AND EXISTS(SELECT 1 FROM file_entries e WHERE ${guard}) RETURNING id`,
          [
            timestamp,
            updated.r2_version,
            updated.mime,
            updated.width,
            updated.height,
            o.id,
            ...guardValues,
          ],
        ),
        this.statement(
          `UPDATE file_entries AS e SET ${selectedRole === "source" ? "state='ready'" : "thumbnail_state='ready'"},version=version+1,updated_at=? WHERE ${guard} RETURNING id`,
          [timestamp, ...guardValues],
        ),
        this.contextStatement(fileId, session),
      ]);
      const result = this.contextRow(results[2]?.results[0] as Row | undefined);
      if (!results[1]?.results.length) {
        if (result.row.version !== expectedVersion) stale();
        this.upload(result, selectedRole, Date.now());
        conflict();
      }
      return result.entry;
    } catch (error) {
      failure(error);
    }
  }
  async getStoredObject(
    fileId: string,
    selectedRole: FileRole,
  ): Promise<StoredFileObject> {
    role(selectedRole);
    const result = stored(await this.context(fileId), selectedRole);
    if (!result) missing();
    return result;
  }
}
