import type { AuthSession } from "../shared/auth";
import { REDIRECT_LIMITS, type RedirectListOptions } from "../shared/redirects";
import { csrf, json, readJson, sameOrigin } from "./admin-http";
import { sha256 } from "./auth/crypto";
import { RedirectError, RedirectService } from "./redirects/service";

const queryFields = [
  "origin",
  "q",
  "translationId",
  "sourcePath",
  "cursor",
  "limit",
];

function fields(input: Record<string, unknown>, required: string[]) {
  if (
    Object.keys(input).length !== required.length ||
    !required.every((key) => Object.hasOwn(input, key)) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    Number(input.expectedVersion) < 1 ||
    required.some(
      (key) => key !== "expectedVersion" && typeof input[key] !== "string",
    )
  )
    throw new RedirectError(400, "Invalid redirect request fields.");
}

function options(params: URLSearchParams): RedirectListOptions {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!queryFields.includes(key) || seen.has(key))
      throw new RedirectError(400, "Invalid redirect query.");
    seen.add(key);
  }
  const result: RedirectListOptions = {};
  const origin = params.get("origin");
  if (origin !== null) {
    if (origin !== "automatic" && origin !== "manual")
      throw new RedirectError(400, "Invalid redirect origin.");
    result.origin = origin;
  }
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > REDIRECT_LIMITS.page)
      throw new RedirectError(400, "Invalid redirect page size.");
    result.limit = Number(limit);
  }
  for (const key of ["q", "translationId", "sourcePath", "cursor"] as const) {
    const value = params.get(key);
    if (value !== null) result[key] = value;
  }
  return result;
}

// HTTP authenticates before dispatch; the service also guards private reads and
// each statement of a registry mutation against a revoked or expired session.
export async function adminRedirects(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/admin/redirects" &&
    !url.pathname.startsWith("/api/admin/redirects/")
  )
    return null;
  const match = /^\/api\/admin\/redirects\/([^/]+)$/.exec(url.pathname);
  if (!match) return json({ error: "Not found" }, 404);
  const language = match[1];
  if (language !== "zh" && language !== "en")
    throw new RedirectError(400, "Invalid redirect language.");
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method))
    return json({ error: "Method not allowed" }, 405, {
      Allow: "GET, POST, PUT, DELETE",
    });
  const service = new RedirectService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  if (request.method === "GET")
    return json(await service.list(language, options(url.searchParams)));
  if (url.searchParams.size)
    throw new RedirectError(400, "Invalid redirect query.");
  sameOrigin(request);
  csrf(request, session);
  const input = await readJson(request, REDIRECT_LIMITS.body);
  if (request.method === "DELETE") {
    fields(input, ["expectedVersion", "sourcePath"]);
    return json(
      await service.delete(language, {
        expectedVersion: input.expectedVersion as number,
        sourcePath: input.sourcePath as string,
      }),
    );
  }
  fields(
    input,
    request.method === "POST"
      ? ["expectedVersion", "path", "translationId"]
      : ["expectedVersion", "sourcePath", "path", "translationId"],
  );
  const target = {
    expectedVersion: input.expectedVersion as number,
    path: input.path as string,
    translationId: input.translationId as string,
  };
  if (request.method === "POST")
    return json(await service.create(language, target), 201);
  return json(
    await service.update(language, {
      ...target,
      sourcePath: input.sourcePath as string,
    }),
  );
}
