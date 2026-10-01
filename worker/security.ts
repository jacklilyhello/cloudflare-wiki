export const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Only successful public documents and crawler resources opt into indexing.
// APIs, admin documents, search results and errors retain the private policy.
export function publicSecurityHeaders(env: { APP_ENV: string }) {
  const { "X-Robots-Tag": _robots, ...headers } = securityHeaders;
  return env.APP_ENV === "production" ? headers : securityHeaders;
}

export function jsonError(message: string, status: number) {
  return Response.json(
    { error: message },
    { status, headers: securityHeaders },
  );
}

export function methodNotAllowed() {
  return new Response(null, {
    status: 405,
    headers: { ...securityHeaders, Allow: "GET, HEAD" },
  });
}

export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
