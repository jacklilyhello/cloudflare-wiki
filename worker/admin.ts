import {
  normalizeAdminReturnTo,
  parseAdminRoute,
} from "../shared/admin-routes";
import type { AuthGrant } from "../shared/auth";
import type { Language } from "../shared/contracts";
import { adminAudit } from "./admin-audit";
import { adminContent } from "./admin-content";
import { adminHeaders, csrf, json, readJson, sameOrigin } from "./admin-http";
import { adminNavigation } from "./admin-navigation";
import { AuditError } from "./audit/service";
import { AuthError, AuthService } from "./auth/service";
import { ContentError } from "./content/service";
import { editorPolicy } from "./editor-policy";
import { NavigationError } from "./navigation/service";

const cookieName = "__Host-wiki_session";
const encoder = new TextEncoder();

function cookie(token: string, expiresAt: string) {
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`;
}

const clearCookie = `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function sessionToken(request: Request): string {
  const header = request.headers.get("Cookie") ?? "";
  if (header.length > 4096) return "";
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName}=`))
    .map((part) => part.slice(cookieName.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0] ?? "")
    ? (values[0] ?? "")
    : "";
}

function text(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string")
    throw new AuthError(400, `Invalid ${key}.`);
  return body[key];
}

function version(body: Record<string, unknown>): number {
  if (
    !Number.isSafeInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1
  )
    throw new AuthError(400, "Invalid account version.");
  return Number(body.expectedVersion);
}

async function ipKey(request: Request): Promise<string> {
  // Cloudflare sets CF-Connecting-IP at the trusted ingress. Local workerd uses
  // one shared fallback bucket. Neither raw IPs nor credentials are logged.
  const source = request.headers.get("CF-Connecting-IP") ?? "local";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`wiki-login:${source}`),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function signedIn(grant: AuthGrant) {
  // A session bearer token must only enter its HttpOnly cookie, never JSON.
  return json({ session: grant.session }, 200, {
    "Set-Cookie": cookie(grant.token, grant.session.expiresAt),
  });
}

async function overview(db: D1Database) {
  const [pages, revisions, recent] = await Promise.all([
    db
      .prepare(`SELECT
      coalesce(sum(deleted_at IS NULL),0) AS total,
      coalesce(sum(deleted_at IS NULL AND draft_revision_id IS NOT NULL AND
        (published_revision_id IS NULL OR draft_revision_id <> published_revision_id)),0) AS drafts,
      coalesce(sum(deleted_at IS NULL AND published_revision_id IS NOT NULL),0) AS published,
      coalesce(sum(deleted_at IS NOT NULL),0) AS deleted
      FROM page_translations`)
      .first(),
    db
      .prepare("SELECT count(*) AS total FROM page_revisions")
      .first<{ total: number }>(),
    db
      .prepare(`SELECT t.id,t.language,t.slug AS path,r.title,t.updated_at AS updatedAt,
      t.published_revision_id IS NOT NULL AS published
      FROM page_translations t JOIN page_revisions r
        ON r.id=t.draft_revision_id AND r.translation_id=t.id
      WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC,t.id LIMIT 8`)
      .all<{
        id: string;
        language: Language;
        path: string;
        title: string;
        updatedAt: string;
        published: number;
      }>(),
  ]);
  return {
    pages,
    revisions: revisions?.total ?? 0,
    recent: recent.results.map((row) => ({
      ...row,
      published: row.published === 1,
    })),
  };
}

export async function adminApi(request: Request, env: Env): Promise<Response> {
  try {
    const service = new AuthService(env.DB);
    const path = new URL(request.url).pathname;
    if (path === "/api/admin/setup" && request.method === "GET")
      return json(await service.bootstrapStatus());

    if (["/api/admin/setup", "/api/admin/login"].includes(path)) {
      if (request.method !== "POST")
        return json({ error: "Method not allowed" }, 405, {
          Allow: path.endsWith("setup") ? "GET, POST" : "POST",
        });
      sameOrigin(request);
      const body = await readJson(request);
      const input = {
        username: text(body, "username"),
        password: text(body, "password"),
      };
      const key = await ipKey(request);
      const grant = path.endsWith("setup")
        ? await service.setup({ ...input, token: text(body, "token") }, key)
        : await service.login(input, key);
      return signedIn(grant);
    }

    const rawToken = sessionToken(request);
    const session = await service.getSession(rawToken);
    if (!session)
      return json({ error: "Sign in required" }, 401, {
        "Set-Cookie": clearCookie,
      });

    if (path === "/api/admin/session" && request.method === "GET")
      return json({ authenticated: true, session });
    if (path === "/api/admin/overview" && request.method === "GET")
      return json(await overview(env.DB));

    if (
      [
        "/api/admin/logout",
        "/api/admin/password",
        "/api/admin/profile",
      ].includes(path)
    ) {
      const method = path.endsWith("logout") ? "POST" : "PUT";
      if (request.method !== method)
        return json({ error: "Method not allowed" }, 405, { Allow: method });
      sameOrigin(request);
      csrf(request, session);
      if (path.endsWith("logout")) await service.logout(rawToken);
      else {
        const body = await readJson(request);
        const currentPassword = text(body, "currentPassword");
        const expectedVersion = version(body);
        if (path.endsWith("password"))
          await service.changePassword(rawToken, {
            currentPassword,
            newPassword: text(body, "newPassword"),
            expectedVersion,
          });
        else
          await service.updateUsername(rawToken, {
            currentPassword,
            username: text(body, "username"),
            expectedVersion,
          });
      }
      return new Response(null, {
        status: 204,
        headers: { ...adminHeaders, "Set-Cookie": clearCookie },
      });
    }
    const contentResponse = await adminContent(request, env, session, rawToken);
    if (contentResponse) return contentResponse;
    const navigationResponse = await adminNavigation(
      request,
      env,
      session,
      rawToken,
    );
    if (navigationResponse) return navigationResponse;
    const auditResponse = await adminAudit(request, env, session, rawToken);
    return auditResponse ?? json({ error: "Not found" }, 404);
  } catch (error) {
    if (
      error instanceof AuthError ||
      error instanceof AuditError ||
      error instanceof ContentError ||
      error instanceof NavigationError
    )
      return json(
        { error: error.message },
        error.status,
        error.status === 429 ? { "Retry-After": "600" } : {},
      );
    return json({ error: "Administration temporarily unavailable" }, 503);
  }
}

export async function adminShell(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, {
      status: 405,
      headers: { ...adminHeaders, Allow: "GET, HEAD" },
    });
  const url = new URL(request.url);
  const pathname = url.pathname;
  const route = parseAdminRoute(pathname);
  if (route.page === "editor" || route.page === "history") {
    const returnTo = normalizeAdminReturnTo(`${pathname}${url.search}`);
    try {
      if (!(await new AuthService(env.DB).getSession(sessionToken(request))))
        return new Response(null, {
          status: 303,
          headers: {
            ...adminHeaders,
            Location: returnTo
              ? `/admin?returnTo=${encodeURIComponent(returnTo)}`
              : "/admin",
          },
        });
    } catch {
      return json({ error: "Administration temporarily unavailable" }, 503);
    }
  }
  const template = await env.ASSETS.fetch(
    new Request(new URL("/index.html", request.url)),
  );
  if (!template.ok)
    return json({ error: "Administration temporarily unavailable" }, 503);
  const policy = editorPolicy(pathname);
  const rewriter = new HTMLRewriter().on("title", {
    element(element) {
      element.setInnerContent("Administration · Emby Wiki");
    },
  });
  if (policy)
    rewriter.on("head", {
      element(element) {
        element.append(`<meta property="csp-nonce" nonce="${policy.nonce}">`, {
          html: true,
        });
      },
    });
  const transformed = rewriter.transform(template);
  return new Response(request.method === "HEAD" ? null : transformed.body, {
    status: route.page === "not-found" ? 404 : 200,
    headers: {
      ...adminHeaders,
      "Content-Type": "text/html; charset=utf-8",
      ...(policy ? { "Content-Security-Policy": policy.csp } : {}),
    },
  });
}
