import type { AdminTranslation } from "../../shared/content";
import type { Language } from "../../shared/contracts";
import {
  DIRECTORY_LIMITS,
  type DirectoryMoveCommit,
  type DirectoryMovePreview,
  type DirectoryMoveResult,
  type PageDirectory,
} from "../../shared/directories";
import { isContentPath } from "../../shared/page-path";

export interface DirectoryMoveAttempt {
  preview: DirectoryMovePreview;
}
export interface DirectoryInspection {
  kind: "moved" | "unchanged" | "changed";
  stable: boolean;
  version: number;
  pages: (AdminTranslation | null)[];
}
export interface DirectoryInspectionReader {
  registry(language: Language, signal: AbortSignal): Promise<PageDirectory>;
  page(id: string, signal: AbortSignal): Promise<AdminTranslation | null>;
}
export class DirectoryInspectionError extends Error {
  constructor() {
    super("The directory response could not be verified.");
  }
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
function invalid(): never {
  throw new DirectoryInspectionError();
}
export function directoryCommit(
  preview: DirectoryMovePreview,
): DirectoryMoveCommit {
  if (
    !preview ||
    !["zh", "en"].includes(preview.language) ||
    !validVersion(preview.version) ||
    !isContentPath(preview.fromPath) ||
    !isContentPath(preview.toPath) ||
    preview.fromPath === preview.toPath ||
    preview.fromPath.startsWith(`${preview.toPath}/`) ||
    preview.toPath.startsWith(`${preview.fromPath}/`) ||
    !Array.isArray(preview.members) ||
    !preview.members.length ||
    preview.members.length > DIRECTORY_LIMITS.move
  )
    invalid();
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const member of preview.members) {
    if (
      !member ||
      typeof member.id !== "string" ||
      !identifier.test(member.id) ||
      ids.has(member.id) ||
      !validVersion(member.version) ||
      member.version >= Number.MAX_SAFE_INTEGER ||
      !isContentPath(member.fromPath) ||
      !isContentPath(member.toPath) ||
      paths.has(member.fromPath) ||
      (member.fromPath !== preview.fromPath &&
        !member.fromPath.startsWith(`${preview.fromPath}/`)) ||
      member.toPath !==
        preview.toPath + member.fromPath.slice(preview.fromPath.length) ||
      typeof member.title !== "string" ||
      typeof member.published !== "boolean"
    )
      invalid();
    ids.add(member.id);
    paths.add(member.fromPath);
  }
  if (
    preview.publishedCount !==
    preview.members.filter((member) => member.published).length
  )
    invalid();
  return {
    fromPath: preview.fromPath,
    toPath: preview.toPath,
    expectedVersion: preview.version,
    expectedMembers: preview.members.map(({ id, version }) => ({
      id,
      version,
    })),
  };
}
function registry(value: PageDirectory, language: Language) {
  if (
    !value ||
    value.language !== language ||
    value.path !== "" ||
    !validVersion(value.version)
  )
    invalid();
  return value.version;
}
function tuple(page: AdminTranslation | null, id: string, language: Language) {
  if (page === null) return null;
  if (
    !page ||
    page.id !== id ||
    page.language !== language ||
    !isContentPath(page.path) ||
    !validVersion(page.version) ||
    !validVersion(page.revisionSeq) ||
    typeof page.pageId !== "string" ||
    !identifier.test(page.pageId) ||
    typeof page.draftRevisionId !== "string" ||
    !identifier.test(page.draftRevisionId) ||
    (page.publishedRevisionId !== null &&
      (typeof page.publishedRevisionId !== "string" ||
        !identifier.test(page.publishedRevisionId))) ||
    (page.publishedRevisionId === null) !== (page.publishedAt === null) ||
    [page.createdAt, page.updatedAt].some(
      (date) => typeof date !== "string" || !Number.isFinite(Date.parse(date)),
    ) ||
    [page.deletedAt, page.publishedAt].some(
      (date) =>
        date !== null &&
        (typeof date !== "string" || !Number.isFinite(Date.parse(date))),
    )
  )
    invalid();
  return JSON.stringify([
    page.id,
    page.pageId,
    page.language,
    page.path,
    page.version,
    page.revisionSeq,
    page.draftRevisionId,
    page.publishedRevisionId,
    page.createdAt,
    page.updatedAt,
    page.publishedAt,
    page.deletedAt,
  ]);
}

export function verifyDirectoryMoveResult(
  preview: DirectoryMovePreview,
  result: DirectoryMoveResult,
): DirectoryMoveResult {
  directoryCommit(preview);
  if (
    !result ||
    result.language !== preview.language ||
    result.fromPath !== preview.fromPath ||
    result.toPath !== preview.toPath ||
    !validVersion(result.version) ||
    result.version <= preview.version ||
    !Array.isArray(result.items) ||
    result.items.length !== preview.members.length
  )
    invalid();
  const ids = new Set<string>();
  for (const page of result.items) {
    const member = preview.members.find((item) => item.id === page?.id);
    if (!member || ids.has(member.id)) invalid();
    tuple(page, member.id, preview.language);
    if (
      page.path !== member.toPath ||
      page.version !== member.version + 1 ||
      page.deletedAt !== null
    )
      invalid();
    ids.add(member.id);
  }
  return result;
}

// These reads never repeat a write. Two complete rounds catch revision-only
// changes which do not advance the route registry; the fences catch structure.
export async function inspectDirectoryMove(
  attempt: DirectoryMoveAttempt,
  reader: DirectoryInspectionReader,
  signal: AbortSignal,
): Promise<DirectoryInspection> {
  const preview = structuredClone(attempt.preview);
  directoryCommit(preview);
  signal.throwIfAborted();
  const before = registry(
    await reader.registry(preview.language, signal),
    preview.language,
  );
  async function round() {
    const pages: (AdminTranslation | null)[] = [];
    for (let index = 0; index < preview.members.length; index += 4) {
      signal.throwIfAborted();
      const group = await Promise.all(
        preview.members.slice(index, index + 4).map(async (member) => {
          const page = await reader.page(member.id, signal);
          signal.throwIfAborted();
          tuple(page, member.id, preview.language);
          return page;
        }),
      );
      pages.push(...group);
    }
    return pages;
  }
  const first = await round();
  const second = await round();
  const after = registry(
    await reader.registry(preview.language, signal),
    preview.language,
  );
  signal.throwIfAborted();
  const stable =
    before === after &&
    first.every((page, index) => {
      const member = preview.members[index];
      const next = second[index];
      if (!member || next === undefined) invalid();
      return (
        tuple(page, member.id, preview.language) ===
        tuple(next, member.id, preview.language)
      );
    });
  const all = (moved: boolean) =>
    second.every((page, index) => {
      const member = preview.members[index];
      if (!member) invalid();
      return (
        page !== null &&
        page.deletedAt === null &&
        page.path === (moved ? member.toPath : member.fromPath) &&
        page.version === member.version + (moved ? 1 : 0)
      );
    });
  const kind =
    stable && after > preview.version && all(true)
      ? "moved"
      : stable && after === preview.version && all(false)
        ? "unchanged"
        : "changed";
  return { kind, stable, version: after, pages: second };
}
