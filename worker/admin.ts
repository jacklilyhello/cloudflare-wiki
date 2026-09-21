import { timingSafeEqual } from "node:crypto";
import type { AuthGrant, AuthSession } from "../shared/auth";
import type { Language } from "../shared/contracts";
import { AuthError, AuthService } from "./auth/service";
import { securityHeaders } from "./security";

const cookieName = "__Host-wiki_session";
const adminHeaders = { ...securityHeaders, Vary: "Cookie, Origin" };
const encoder = new TextEncoder();

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(value, {
    status,
    headers: { ...adminHeaders, ...headers },
  });
}

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

function sameOrigin(request: Request) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (
    request.headers.get("Origin") !== new URL(request.url).origin ||
    (site !== null && site !== "same-origin" && site !== "none")
  )
    throw new AuthError(403, "This request must come from this site.");
}

function csrf(request: Request, session: AuthSession) {
  const supplied = encoder.encode(request.headers.get("X-CSRF-Token") ?? "");
  const expected = encoder.encode(session.csrfToken);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new AuthError(403, "Invalid request token. Reload and try again.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new AuthError(400, "A JSON request is required.");
  if (Number(request.headers.get("Content-Length") ?? 0) > 4096)
    throw new AuthError(400, "The request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        throw new AuthError(400, "The request is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid JSON object");
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(400, "Invalid JSON request.");
  } finally {
    reader.releaseLock();
  }
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
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof AuthError)
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
  const template = await env.ASSETS.fetch(
    new Request(new URL("/index.html", request.url)),
  );
  if (!template.ok)
    return json({ error: "Administration temporarily unavailable" }, 503);
  const transformed = new HTMLRewriter()
    .on("title", {
      element(element) {
        element.setInnerContent("Administration · Emby Wiki");
      },
    })
    .transform(template);
  return new Response(request.method === "HEAD" ? null : transformed.body, {
    headers: { ...adminHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}
