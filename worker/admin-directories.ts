import type { AuthSession } from "../shared/auth";
import {
  DIRECTORY_LIMITS,
  type DirectoryMoveCommit,
  type PageDirectoryOptions,
} from "../shared/directories";
import { csrf, json, readJson, sameOrigin } from "./admin-http";
import { sha256 } from "./auth/crypto";
import { PageDirectoryService } from "./content/directories";
import { ContentError } from "./content/service";

function shape(value: Record<string, unknown>, keys: string[]) {
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ContentError(400, "Invalid directory request fields.");
}

function text(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string")
    throw new ContentError(400, "Invalid directory path.");
  return value[key];
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new ContentError(400, "Invalid directory version.");
  return Number(value);
}

function members(value: unknown): DirectoryMoveCommit["expectedMembers"] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > DIRECTORY_LIMITS.move
  )
    throw new ContentError(400, "Invalid directory members.");
  return value.map((member: unknown) => {
    if (!member || typeof member !== "object" || Array.isArray(member))
      throw new ContentError(400, "Invalid directory member.");
    const item = member as Record<string, unknown>;
    shape(item, ["id", "version"]);
    const id = text(item, "id");
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id))
      throw new ContentError(400, "Invalid directory member.");
    return { id, version: version(item.version) };
  });
}

function query(params: URLSearchParams, allowed: string[]) {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key) || !allowed.includes(key))
      throw new ContentError(400, "Invalid directory query.");
    seen.add(key);
  }
}

// adminApi has already verified the cookie; the service independently guards
// every SQL read and the entire move transaction with that same live identity.
export async function adminDirectories(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/admin/directories" &&
    !url.pathname.startsWith("/api/admin/directories/")
  )
    return null;
  const match =
    /^\/api\/admin\/directories\/([^/]+)(?:\/(preview|move))?$/.exec(
      url.pathname,
    );
  if (!match) return json({ error: "Not found" }, 404);
  const language = match[1];
  if (language !== "zh" && language !== "en")
    throw new ContentError(400, "Invalid content language.");
  const action = match[2];
  const method = action ? "POST" : "GET";
  if (request.method !== method)
    return json({ error: "Method not allowed" }, 405, { Allow: method });
  const service = new PageDirectoryService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  if (!action) {
    query(url.searchParams, ["path", "cursor", "limit"]);
    const options: PageDirectoryOptions = {};
    if (url.searchParams.has("path"))
      options.path = url.searchParams.get("path") ?? "";
    if (url.searchParams.has("cursor")) {
      const cursor = url.searchParams.get("cursor") ?? "";
      if (!cursor || cursor.length > DIRECTORY_LIMITS.cursor)
        throw new ContentError(400, "Invalid directory cursor.");
      options.cursor = cursor;
    }
    if (url.searchParams.has("limit")) {
      const limit = url.searchParams.get("limit") ?? "";
      if (
        !/^[1-9][0-9]{0,2}$/.test(limit) ||
        Number(limit) > DIRECTORY_LIMITS.page
      )
        throw new ContentError(400, "Invalid directory page size.");
      options.limit = Number(limit);
    }
    return json(await service.list(language, options));
  }
  query(url.searchParams, []);
  sameOrigin(request);
  csrf(request, session);
  const input = await readJson(request, DIRECTORY_LIMITS.bodyBytes);
  shape(
    input,
    action === "preview"
      ? ["fromPath", "toPath"]
      : ["fromPath", "toPath", "expectedVersion", "expectedMembers"],
  );
  const paths = {
    fromPath: text(input, "fromPath"),
    toPath: text(input, "toPath"),
  };
  return json(
    action === "preview"
      ? await service.preview(language, paths)
      : await service.move(language, {
          ...paths,
          expectedVersion: version(input.expectedVersion),
          expectedMembers: members(input.expectedMembers),
        }),
  );
}
