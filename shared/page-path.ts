import { CONTENT_LIMITS } from "./content";

export function contentPathIssue(
  value: unknown,
): "invalid" | "reserved" | null {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > CONTENT_LIMITS.path ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    value !== value.toLowerCase() ||
    !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value)
  )
    return "invalid";
  // These are application routes, never public article paths.
  return [
    "search",
    "admin",
    "api",
    "assets",
    "health",
    "robots.txt",
    "sitemap.xml",
  ].includes(value.split("/")[0] ?? "")
    ? "reserved"
    : null;
}

/** A canonical, nonempty article path. Virtual-directory roots use "" separately. */
export function isContentPath(value: unknown): value is string {
  return contentPathIssue(value) === null;
}
