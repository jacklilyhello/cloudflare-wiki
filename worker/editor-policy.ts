import { parseAdminRoute } from "../shared/admin-routes";
import { securityHeaders } from "./security";

export function editorPolicy(pathname: string) {
  const route = parseAdminRoute(pathname);
  if (route.page !== "editor" && route.page !== "history") return null;
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))),
  );
  // Monaco emits layout style attributes. Limit that exception to its own
  // document; dynamic style elements still require this per-response nonce.
  // Script/eval, external resources, framing and all reader policies stay strict.
  const csp = securityHeaders["Content-Security-Policy"].replace(
    "style-src 'self'",
    `style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; worker-src 'self'`,
  );
  return { nonce, csp };
}
