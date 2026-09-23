import { FILE_LIMITS, type FileEntry, type FilePage } from "../../shared/files";
import { FileBrowserChanged } from "./files-browser-model";

export interface FolderCreateAttempt {
  name: string;
  parentId: string | null;
}
export interface FolderCreateInspection {
  libraryVersion: number;
  nextCursor: string | null;
  match: FileEntry | null;
  readCount: number;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controls = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u;

function changed(): never {
  throw new FileBrowserChanged();
}
function nameKey(name: string): string {
  if (typeof name !== "string" || controls.test(name)) changed();
  const normalized = name.normalize("NFC").trim();
  if (
    !normalized ||
    normalized.length > FILE_LIMITS.name ||
    normalized === "." ||
    normalized === ".." ||
    /[\\/]/.test(normalized)
  )
    changed();
  const key = normalized.normalize("NFKC").toLowerCase();
  if (key.length > 1000) changed();
  return key;
}
function validCursor(cursor: string | null): boolean {
  return (
    cursor === null ||
    (typeof cursor === "string" &&
      cursor.length <= FILE_LIMITS.cursor &&
      /^[A-Za-z0-9_-]+$/.test(cursor))
  );
}
function checkAttempt(attempt: FolderCreateAttempt) {
  if (
    !attempt ||
    (attempt.parentId !== null &&
      (typeof attempt.parentId !== "string" || !uuid.test(attempt.parentId)))
  )
    changed();
  return nameKey(attempt.name);
}
function checkPrevious(previous: FolderCreateInspection | null | undefined) {
  if (
    previous &&
    (!Number.isSafeInteger(previous.libraryVersion) ||
      previous.libraryVersion < 1 ||
      !Number.isSafeInteger(previous.readCount) ||
      previous.readCount < 0 ||
      previous.match !== null ||
      previous.nextCursor === null ||
      !validCursor(previous.nextCursor))
  )
    changed();
}

export function folderInspectionQuery(
  attempt: FolderCreateAttempt,
  previous?: FolderCreateInspection | null,
): string {
  checkAttempt(attempt);
  checkPrevious(previous);
  // Scan the exact original folder. A normalized name can exceed the search
  // endpoint's query bound, and one filtered page cannot establish absence.
  const query = new URLSearchParams({
    parentId: attempt.parentId ?? "",
    state: "active",
    limit: String(FILE_LIMITS.page),
  });
  if (previous?.nextCursor) query.set("cursor", previous.nextCursor);
  return `files?${query}`;
}

export function mergeFolderInspection(
  attempt: FolderCreateAttempt,
  previous: FolderCreateInspection | null | undefined,
  page: FilePage,
): FolderCreateInspection {
  const target = checkAttempt(attempt);
  checkPrevious(previous);
  if (
    !page ||
    !Number.isSafeInteger(page.libraryVersion) ||
    page.libraryVersion < 1 ||
    !Array.isArray(page.items) ||
    page.items.length > FILE_LIMITS.page ||
    !validCursor(page.nextCursor) ||
    (previous &&
      (previous.libraryVersion !== page.libraryVersion ||
        previous.nextCursor === page.nextCursor))
  )
    changed();
  const ids = new Set<string>();
  const names = new Set<string>();
  let match: FileEntry | null = null;
  for (const entry of page.items) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !uuid.test(entry.id) ||
      ids.has(entry.id) ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 1 ||
      entry.parentId !== attempt.parentId ||
      entry.deletedAt !== null ||
      !["folder", "file"].includes(entry.kind) ||
      !["ready", "pending"].includes(entry.state) ||
      (entry.kind === "folder" && entry.state !== "ready")
    )
      changed();
    ids.add(entry.id);
    const key = nameKey(entry.name);
    if (names.has(key)) changed();
    names.add(key);
    if (key === target) {
      if (match) changed();
      // A file with the requested name is a collision too; preserve its kind.
      match = entry;
    }
  }
  const readCount = (previous?.readCount ?? 0) + page.items.length;
  if (!Number.isSafeInteger(readCount)) changed();
  return {
    libraryVersion: page.libraryVersion,
    nextCursor: match ? null : page.nextCursor,
    match,
    readCount,
  };
}
