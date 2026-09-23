export type AdminRoute =
  | {
      page:
        | "dashboard"
        | "account"
        | "pages"
        | "files"
        | "navigation"
        | "redirects"
        | "settings"
        | "audit"
        | "not-found";
    }
  | { page: "editor"; translationId?: string }
  | { page: "history"; translationId: string };

// Shared by the document's CSP boundary and the UI. Changing routes uses a full
// document navigation so the browser receives the matching policy and nonce.
export function parseAdminRoute(pathname: string): AdminRoute {
  const path = pathname.replace(/\/$/, "");
  if (path === "/admin") return { page: "dashboard" };
  if (path === "/admin/account") return { page: "account" };
  if (path === "/admin/pages") return { page: "pages" };
  if (path === "/admin/files") return { page: "files" };
  if (path === "/admin/navigation") return { page: "navigation" };
  if (path === "/admin/redirects") return { page: "redirects" };
  if (path === "/admin/settings") return { page: "settings" };
  if (path === "/admin/audit") return { page: "audit" };
  if (path === "/admin/pages/new") return { page: "editor" };
  const match = /^\/admin\/pages\/([^/]+)\/(edit|history)$/.exec(path);
  if (!match?.[1]) return { page: "not-found" };
  let translationId: string;
  try {
    translationId = decodeURIComponent(match[1]);
  } catch {
    return { page: "not-found" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(translationId))
    return { page: "not-found" };
  return { page: match[2] === "edit" ? "editor" : "history", translationId };
}

// Only editor/history documents may be resumed after login. New translations
// preserve their language and stable page identity through a closed query schema.
export function normalizeAdminReturnTo(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !value.startsWith("/admin/pages/") ||
    /[\\#]/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const target = new URL(value, "https://wiki.invalid");
    if (
      target.origin !== "https://wiki.invalid" ||
      target.pathname !== value.split("?")[0]
    )
      return null;
    const route = parseAdminRoute(target.pathname);
    if (route.page !== "editor" && route.page !== "history") return null;
    if (route.translationId) {
      if (target.searchParams.size) return null;
      return `/admin/pages/${encodeURIComponent(route.translationId)}/${route.page === "editor" ? "edit" : "history"}`;
    }
    const seen = new Set<string>();
    for (const [key, parameter] of target.searchParams) {
      if (seen.has(key)) return null;
      seen.add(key);
      if (key === "language") {
        if (parameter !== "zh" && parameter !== "en") return null;
      } else if (key === "pageId") {
        if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(parameter)) return null;
      } else return null;
    }
    const query = new URLSearchParams();
    for (const key of ["language", "pageId"])
      if (seen.has(key)) query.set(key, target.searchParams.get(key) ?? "");
    return `/admin/pages/new${query.size ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}
