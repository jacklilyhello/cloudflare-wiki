import type { AuthSession } from "../shared/auth";
import type { NavigationNode } from "../shared/navigation";
import { csrf, json, readJson, sameOrigin } from "./admin-http";
import { sha256 } from "./auth/crypto";
import { NavigationError, NavigationService } from "./navigation/service";

const bodyLimit = 500 * 1024;
const nodeFields = [
  "id",
  "parentId",
  "position",
  "kind",
  "label",
  "translationId",
  "externalUrl",
];

function shape(
  value: unknown,
  fields: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    fields.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

function nullableText(value: unknown) {
  return value === null || typeof value === "string";
}

function nodes(value: unknown): NavigationNode[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (node) =>
        !shape(node, nodeFields) ||
        typeof node.id !== "string" ||
        !nullableText(node.parentId) ||
        !Number.isSafeInteger(node.position) ||
        Number(node.position) < 0 ||
        typeof node.kind !== "string" ||
        !["group", "page", "link"].includes(node.kind) ||
        !nullableText(node.label) ||
        !nullableText(node.translationId) ||
        !nullableText(node.externalUrl),
    )
  )
    throw new NavigationError(400, "Invalid navigation nodes.");
  return value as NavigationNode[];
}

// adminApi authenticates the session before dispatch; the service checks the
// same identity again in private reads and every statement of its write batch.
export async function adminNavigation(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/admin/navigation" &&
    !url.pathname.startsWith("/api/admin/navigation/")
  )
    return null;
  const match = /^\/api\/admin\/navigation\/([^/]+)$/.exec(url.pathname);
  if (!match) return json({ error: "Not found" }, 404);
  const language = match[1];
  if (language !== "zh" && language !== "en")
    throw new NavigationError(400, "Invalid navigation language.");
  if (request.method !== "GET" && request.method !== "PUT")
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  if (url.searchParams.size !== 0)
    throw new NavigationError(400, "Invalid navigation query.");
  const service = new NavigationService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  if (request.method === "GET") return json(await service.get(language));
  sameOrigin(request);
  csrf(request, session);
  const input = await readJson(request, bodyLimit);
  if (
    !shape(input, ["expectedVersion", "mode", "nodes"]) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    Number(input.expectedVersion) < 1 ||
    (input.mode !== "automatic" && input.mode !== "custom")
  )
    throw new NavigationError(400, "Invalid navigation request fields.");
  return json(
    await service.save(language, {
      expectedVersion: Number(input.expectedVersion),
      mode: input.mode,
      nodes: nodes(input.nodes),
    }),
  );
}
