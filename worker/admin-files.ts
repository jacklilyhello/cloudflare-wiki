import type { AuthSession } from "../shared/auth";
import {
  type CreateFolderInput,
  FILE_LIMITS,
  type FileAltInput,
  type FileListOptions,
  type FileRole,
  type MoveFileInput,
  type PrepareUploadInput,
  type RenameFileInput,
} from "../shared/files";
import { csrf, json, readJson, sameOrigin } from "./admin-http";
import { sha256 } from "./auth/crypto";
import { FilesError } from "./files/contracts";
import { FilesService } from "./files/service";
import { putPreparedObject, reconcilePreparedObject } from "./files/transfer";
import {
  type FileRepresentation,
  fileIdPattern,
  serveFile,
} from "./files-http";

function noQuery(url: URL) {
  if (url.searchParams.size) throw new FilesError(400, "Invalid file query.");
}
function expectedVersion(body: Record<string, unknown>) {
  if (
    Object.keys(body).length !== 1 ||
    !Number.isSafeInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1
  )
    throw new FilesError(400, "Invalid file version.");
  return Number(body.expectedVersion);
}
function versionHeader(request: Request) {
  const value = request.headers.get("X-File-Version") ?? "";
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new FilesError(400, "A current file version is required.");
  return Number(value);
}
function listOptions(url: URL): FileListOptions {
  const seen = new Set<string>();
  const options: FileListOptions = {};
  for (const [key, value] of url.searchParams) {
    if (seen.has(key)) throw new FilesError(400, "Invalid file query.");
    seen.add(key);
    if (key === "parentId") options.parentId = value || null;
    else if (key === "state") {
      if (value !== "active" && value !== "deleted")
        throw new FilesError(400, "Invalid file state.");
      options.state = value;
    } else if (key === "q") options.q = value;
    else if (key === "cursor") options.cursor = value;
    else if (key === "limit" && /^[1-9]\d?$/.test(value))
      options.limit = Number(value);
    else throw new FilesError(400, "Invalid file query.");
  }
  return options;
}
function method(allowed: string) {
  return json({ error: "Method not allowed" }, 405, { Allow: allowed });
}

export async function adminFiles(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/admin/files" &&
    !url.pathname.startsWith("/api/admin/files/")
  )
    return null;
  const service = new FilesService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  if (url.pathname === "/api/admin/files") {
    if (request.method !== "GET") return method("GET");
    return json(await service.list(listOptions(url)));
  }
  noQuery(url);
  if (
    url.pathname === "/api/admin/files/folders" ||
    url.pathname === "/api/admin/files/uploads"
  ) {
    if (request.method !== "POST") return method("POST");
    sameOrigin(request);
    csrf(request, session);
    const body = await readJson(request, FILE_LIMITS.body);
    return json(
      url.pathname.endsWith("/folders")
        ? await service.createFolder(body as unknown as CreateFolderInput)
        : await service.prepareUpload(body as unknown as PrepareUploadInput),
      201,
    );
  }
  const match =
    /^\/api\/admin\/files\/([^/]+)(?:\/([a-z]+)(?:\/(source|thumbnail))?)?$/.exec(
      url.pathname,
    );
  if (!match || !fileIdPattern.test(match[1] ?? ""))
    return json({ error: "Not found" }, 404);
  const id = match[1] as string;
  const action = match[2];
  const role = match[3] as FileRole | undefined;
  if (!action) {
    if (request.method !== "GET") return method("GET");
    return json(await service.get(id));
  }
  if (["image", "download", "thumbnail"].includes(action) && !role) {
    return serveFile(
      request,
      env.MEDIA,
      () =>
        service.getStoredObject(
          id,
          action === "thumbnail" ? "thumbnail" : "source",
        ),
      action as FileRepresentation,
      true,
    );
  }
  if ((action === "upload" || action === "reconcile") && role) {
    if (request.method !== (action === "upload" ? "PUT" : "POST"))
      return method(action === "upload" ? "PUT" : "POST");
    sameOrigin(request);
    csrf(request, session);
    const version =
      action === "upload"
        ? versionHeader(request)
        : expectedVersion(await readJson(request, FILE_LIMITS.body));
    if (action === "upload") {
      const current = await service.get(id);
      if (current.version !== version)
        throw new FilesError(412, "The file changed. Reload before retrying.");
      if (
        role === "source" ? current.source !== null : current.thumbnail !== null
      )
        throw new FilesError(
          409,
          "This upload is already complete. It cannot be replaced.",
        );
    }
    const descriptor = await service.authorizeUpload(id, role, version);
    if (action === "reconcile") {
      const receipt = await reconcilePreparedObject(env.MEDIA, descriptor);
      return json(await service.finishObject(receipt, version));
    }
    if (
      request.headers.get("Content-Type") !== "application/octet-stream" ||
      request.headers.has("Content-Encoding")
    )
      throw new FilesError(415, "A raw file body is required.");
    const length = request.headers.get("Content-Length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) ||
        !Number.isSafeInteger(Number(length)) ||
        Number(length) !== descriptor.expectedBytes)
    )
      throw new FilesError(
        400,
        "The upload length does not match the prepared file.",
      );
    if (!request.body) throw new FilesError(400, "A file body is required.");
    const receipt = await putPreparedObject(
      env.MEDIA,
      descriptor,
      request.body,
      request.signal,
    );
    return json(await service.finishObject(receipt, version));
  }
  if (
    role ||
    ![
      "rename",
      "move",
      "alt",
      "publish",
      "unpublish",
      "delete",
      "restore",
      "abandon",
    ].includes(action)
  )
    return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return method("POST");
  sameOrigin(request);
  csrf(request, session);
  const body = await readJson(request, FILE_LIMITS.body);
  if (action === "rename")
    return json(await service.rename(id, body as unknown as RenameFileInput));
  if (action === "move")
    return json(await service.move(id, body as unknown as MoveFileInput));
  if (action === "alt")
    return json(await service.updateAlt(id, body as unknown as FileAltInput));
  if (action === "restore")
    return json(await service.restore(id, body as unknown as MoveFileInput));
  const version = expectedVersion(body);
  if (action === "publish") return json(await service.publish(id, version));
  if (action === "unpublish") return json(await service.unpublish(id, version));
  if (action === "delete") return json(await service.softDelete(id, version));
  return json(await service.abandon(id, version));
}
