import type { AuthSession } from "../shared/auth";
import {
  CONTENT_LIMITS,
  type DraftInput,
  type PageListOptions,
} from "../shared/content";
import type { Language } from "../shared/contracts";
import { MarkdownLimitError, renderMarkdown } from "../shared/markdown";
import { csrf, json, readJson, sameOrigin } from "./admin-http";
import { sha256 } from "./auth/crypto";
import { ContentError, ContentService } from "./content/service";

const bodyLimit = 1024 * 1024;
const draftFields = ["title", "description", "markdown", "tags"];

function shape(
  body: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((key) => !Object.hasOwn(body, key)) ||
    Object.keys(body).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new ContentError(400, "Invalid content request fields.");
}

function text(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== "string")
    throw new ContentError(400, `Invalid ${key}.`);
  return body[key];
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value))
    throw new ContentError(400, "Invalid content identifier.");
  return value;
}

function pathIdentifier(value: string): string {
  try {
    return identifier(decodeURIComponent(value));
  } catch {
    throw new ContentError(400, "Invalid content identifier.");
  }
}

function language(value: unknown): Language {
  if (value !== "zh" && value !== "en")
    throw new ContentError(400, "Invalid content language.");
  return value;
}

function version(body: Record<string, unknown>): number {
  if (
    !Number.isSafeInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1
  )
    throw new ContentError(400, "Invalid content version.");
  return Number(body.expectedVersion);
}

function draft(body: Record<string, unknown>): DraftInput {
  if (
    !Array.isArray(body.tags) ||
    body.tags.some((tag) => typeof tag !== "string")
  )
    throw new ContentError(400, "Invalid tags.");
  return {
    title: text(body, "title"),
    description: text(body, "description"),
    markdown: text(body, "markdown"),
    tags: body.tags as string[],
    ...(body.changeNote === undefined
      ? {}
      : { changeNote: text(body, "changeNote") }),
  };
}

function query(params: URLSearchParams, allowed: string[]) {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key) || seen.has(key))
      throw new ContentError(400, "Invalid content query.");
    seen.add(key);
  }
}

function positive(value: string | null, max: number): number | undefined {
  if (value === null) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(value))
    throw new ContentError(400, "Invalid pagination.");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max)
    throw new ContentError(400, "Invalid pagination.");
  return number;
}

function cursor(params: URLSearchParams) {
  const value = params.get("cursor");
  if (value === null) return undefined;
  if (!value || value.length > 2048)
    throw new ContentError(400, "Invalid pagination cursor.");
  return value;
}

function method(request: Request, allowed: string[]) {
  return allowed.includes(request.method)
    ? null
    : json({ error: "Method not allowed" }, 405, { Allow: allowed.join(", ") });
}

async function body(request: Request, session: AuthSession) {
  sameOrigin(request);
  csrf(request, session);
  return readJson(request, bodyLimit);
}

// Authentication is established in adminApi before any content route reaches
// this dispatcher. The same session identity also guards service SQL reads and writes.
export async function adminContent(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/admin/preview") {
    const denied = method(request, ["POST"]);
    if (denied) return denied;
    query(url.searchParams, []);
    const input = await body(request, session);
    shape(input, ["language", "markdown"]);
    try {
      return json(
        await renderMarkdown(text(input, "markdown"), language(input.language)),
      );
    } catch (error) {
      if (error instanceof MarkdownLimitError)
        throw new ContentError(400, error.message);
      throw error;
    }
  }
  if (
    url.pathname !== "/api/admin/pages" &&
    !url.pathname.startsWith("/api/admin/pages/")
  )
    return null;
  const parts = url.pathname.split("/").slice(4);
  const [rawId, action, rawRevisionId, revisionAction] = parts;
  const route =
    parts.length === 0
      ? "list"
      : parts.length === 1
        ? "detail"
        : parts.length === 2 &&
            [
              "draft",
              "publish",
              "unpublish",
              "move",
              "restore",
              "revisions",
              "events",
            ].includes(action ?? "")
          ? action
          : parts.length === 3 && action === "revisions"
            ? "revision"
            : parts.length === 4 &&
                action === "revisions" &&
                revisionAction === "restore"
              ? "revision-restore"
              : null;
  if (!route) return json({ error: "Not found" }, 404);
  const id = rawId === undefined ? undefined : pathIdentifier(rawId);
  const revisionId =
    rawRevisionId === undefined ? undefined : pathIdentifier(rawRevisionId);
  const allowed =
    route === "list"
      ? ["GET", "POST"]
      : route === "detail"
        ? ["GET", "DELETE"]
        : ["revisions", "revision", "events"].includes(route)
          ? ["GET"]
          : route === "draft"
            ? ["PUT"]
            : ["POST"];
  const denied = method(request, allowed);
  if (denied) return denied;
  const service = new ContentService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  if (request.method === "GET") {
    if (route === "list") {
      query(url.searchParams, ["language", "status", "q", "cursor", "limit"]);
      const options: PageListOptions = {
        cursor: cursor(url.searchParams),
        limit: positive(
          url.searchParams.get("limit"),
          CONTENT_LIMITS.revisionPage,
        ),
      };
      if (url.searchParams.has("language"))
        options.language = language(url.searchParams.get("language"));
      if (url.searchParams.has("status")) {
        const status = url.searchParams.get("status");
        if (!["active", "draft", "published", "deleted"].includes(status ?? ""))
          throw new ContentError(400, "Invalid page status.");
        options.status = status as PageListOptions["status"];
      }
      if (url.searchParams.has("q")) {
        const q = url.searchParams.get("q") ?? "";
        if (q.length > 200)
          throw new ContentError(400, "The page query is too long.");
        options.q = q;
      }
      return json(await service.list(options));
    }
    const translationId = id as string;
    if (route === "revisions") {
      query(url.searchParams, ["beforeRevision", "limit"]);
      const limit =
        positive(url.searchParams.get("limit"), CONTENT_LIMITS.revisionPage) ??
        CONTENT_LIMITS.revisionPage;
      const revisions = await service.listRevisions(
        translationId,
        positive(
          url.searchParams.get("beforeRevision"),
          Number.MAX_SAFE_INTEGER,
        ),
        limit,
      );
      return json({
        revisions,
        nextBeforeRevision:
          revisions.length === limit
            ? (revisions.at(-1)?.revisionNo ?? null)
            : null,
      });
    }
    if (route === "events") {
      query(url.searchParams, ["cursor", "limit"]);
      return json(
        await service.listEvents(translationId, {
          cursor: cursor(url.searchParams),
          limit: positive(
            url.searchParams.get("limit"),
            CONTENT_LIMITS.revisionPage,
          ),
        }),
      );
    }
    query(url.searchParams, []);
    if (route === "revision")
      return json({
        revision: await service.getRevision(
          translationId,
          revisionId as string,
        ),
      });
    return json(await service.getDetail(translationId));
  }

  query(url.searchParams, []);
  const input = await body(request, session);
  if (route === "list") {
    shape(
      input,
      [...draftFields, "language", "path"],
      ["pageId", "changeNote"],
    );
    const translation = await service.createTranslation({
      ...draft(input),
      language: language(input.language),
      path: text(input, "path"),
      ...(input.pageId === undefined
        ? {}
        : { pageId: identifier(text(input, "pageId")) }),
    });
    return json({ translation }, 201);
  }
  const translationId = id as string;
  if (route === "draft") {
    shape(input, [...draftFields, "expectedVersion"], ["changeNote"]);
    return json({
      translation: await service.saveDraft(
        translationId,
        version(input),
        draft(input),
      ),
    });
  }
  if (route === "publish") {
    shape(input, ["expectedVersion", "revisionId"]);
    return json({
      translation: await service.publish(
        translationId,
        version(input),
        identifier(text(input, "revisionId")),
      ),
    });
  }
  if (route === "move") {
    shape(input, ["expectedVersion", "path"]);
    return json({
      translation: await service.move(
        translationId,
        version(input),
        text(input, "path"),
      ),
    });
  }
  if (route === "revision-restore") {
    shape(input, ["expectedVersion"], ["changeNote"]);
    return json({
      translation: await service.restoreRevision(
        translationId,
        version(input),
        revisionId as string,
        input.changeNote === undefined ? "" : text(input, "changeNote"),
      ),
    });
  }
  shape(input, ["expectedVersion"]);
  const expectedVersion = version(input);
  const translation =
    route === "detail"
      ? await service.softDelete(translationId, expectedVersion)
      : route === "restore"
        ? await service.restoreDeleted(translationId, expectedVersion)
        : await service.unpublish(translationId, expectedVersion);
  return json({ translation });
}
