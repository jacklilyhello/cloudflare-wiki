import type { Language } from "./contracts";
import { publicPath } from "./paths";

export interface MoveLinkImpact {
  source: string;
  before: string;
  after: string;
  revision: "draft" | "published";
  target: "page" | "missing" | "resource";
}

// Use browser URL semantics, including encoded segments and page-as-directory
// paths. Fragments and query-only URLs still refer to the current document.
export function resolveRelativeLink(
  value: string,
  language: Language,
  path: string,
): string {
  if (
    !value ||
    /^[\s/]*\//.test(value) ||
    /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ||
    /^[?#]/.test(value)
  )
    return value;
  const url = new URL(
    value,
    `https://wiki.invalid${publicPath(language, path)}`,
  );
  // A normalized double-slash pathname must never become a network-path URL.
  const pathname = url.pathname.startsWith("//")
    ? `/.${url.pathname}`
    : url.pathname;
  return `${pathname}${url.search}${url.hash}`;
}
