import { FILE_LIMITS, type FileEntry, type FilePage } from "../../shared/files";

export class FileBrowserChanged extends Error {}
export class FolderPathUnavailable extends Error {}

export function fileBrowserQuery({
  parentId,
  trash,
  query,
  cursor,
}: {
  parentId: string | null;
  trash: boolean;
  query: string;
  cursor?: string;
}) {
  const params = new URLSearchParams({
    state: trash ? "deleted" : "active",
    limit: String(FILE_LIMITS.defaultPage),
  });
  // Trash is a library-wide view, including entries under deleted parents.
  if (!trash) params.set("parentId", parentId ?? "");
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  return `files?${params}`;
}

export function mergeFilePages(
  previous: FilePage | null,
  next: FilePage,
): FilePage {
  if (
    !Number.isSafeInteger(next.libraryVersion) ||
    next.libraryVersion < 1 ||
    next.items.length > FILE_LIMITS.page ||
    (previous && previous.libraryVersion !== next.libraryVersion)
  )
    throw new FileBrowserChanged();
  const items = [...(previous?.items ?? []), ...next.items];
  if (new Set(items.map((entry) => entry.id)).size !== items.length)
    throw new FileBrowserChanged();
  return { ...next, items };
}

export async function resolveFolderTrail(
  parentId: string | null,
  read: (id: string) => Promise<FileEntry>,
): Promise<FileEntry[]> {
  const trail: FileEntry[] = [];
  const seen = new Set<string>();
  let current = parentId;
  while (current !== null) {
    if (seen.has(current) || trail.length >= FILE_LIMITS.folderDepth)
      throw new FolderPathUnavailable();
    seen.add(current);
    const folder = await read(current);
    if (
      folder.id !== current ||
      folder.kind !== "folder" ||
      folder.state !== "ready" ||
      folder.deletedAt !== null
    )
      throw new FolderPathUnavailable();
    trail.unshift(folder);
    current = folder.parentId;
  }
  return trail;
}

export function fileThumbnailPath(entry: FileEntry): string | null {
  if (
    entry.kind !== "file" ||
    entry.state !== "ready" ||
    entry.deletedAt !== null ||
    !entry.source ||
    entry.source.mime === "application/octet-stream" ||
    entry.thumbnailState !== "ready" ||
    !entry.thumbnail ||
    entry.thumbnail.mime === "application/octet-stream"
  )
    return null;
  return `/api/admin/files/${entry.id}/thumbnail`;
}
