import type { Language } from "./contracts";
import { FILE_LIMITS, type FileEntry } from "./files";

export type FileInsertionKind = "image" | "download";

export function isFileImage(entry: FileEntry): boolean {
  return (
    entry.kind === "file" &&
    (entry.source?.mime === "image/png" ||
      entry.source?.mime === "image/jpeg" ||
      entry.source?.mime === "image/webp")
  );
}

export function isInsertableFile(entry: FileEntry): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      entry.id,
    ) &&
    entry.kind === "file" &&
    entry.state === "ready" &&
    entry.deletedAt === null &&
    Boolean(entry.publishedAt) &&
    entry.source !== null
  );
}

export function defaultFileLabel(entry: FileEntry, language: Language): string {
  return entry.alt?.[language]?.trim() || entry.name;
}

// Escape punctuation before Markdown parsing. Entity-looking input, wiki links,
// directives and line breaks remain one literal label, never author syntax.
export function fileMarkdown(
  entry: FileEntry,
  label: string,
  kind: FileInsertionKind,
): string {
  if (
    !isInsertableFile(entry) ||
    (kind !== "image" && kind !== "download") ||
    (kind === "image" && !isFileImage(entry)) ||
    typeof label !== "string" ||
    label.length > FILE_LIMITS.alt
  )
    throw new Error("Invalid file insertion.");
  const text = label.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  if (!text) throw new Error("A file label is required.");
  const escaped = text.replace(/[!-/:-@[-`{-~]/g, "\\$&");
  return `${kind === "image" ? "!" : ""}[${escaped}](/files/${entry.id}/${kind})`;
}
