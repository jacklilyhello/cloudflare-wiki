import { adminHeaders } from "./admin-http";
import { FilesError, type StoredFileObject } from "./files/contracts";
import { getPublicFileObject } from "./files/service";
import { getStoredObject, headStoredObject } from "./files/transfer";
import { securityHeaders } from "./security";

export const fileIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type FileRepresentation = "image" | "download" | "thumbnail";

function notFound(): never {
  throw new FilesError(404, "File not found.");
}
function range(
  value: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (value === null) return null;
  if (value.length > 128)
    throw new FilesError(416, "Requested range is unavailable.");
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size < 1)
    throw new FilesError(416, "Requested range is unavailable.");
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    throw new FilesError(416, "Requested range is unavailable.");
  if (first === null) {
    if (last === null || last < 1)
      throw new FilesError(416, "Requested range is unavailable.");
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (first >= size || (last !== null && last < first))
    throw new FilesError(416, "Requested range is unavailable.");
  return {
    offset: first,
    length: Math.min(last ?? size - 1, size - 1) - first + 1,
  };
}

function disposition(name: string, inline: boolean) {
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? "inline" : "attachment"}; filename="file"; filename*=UTF-8''${encoded}`;
}

/** Every response, including HEAD/304/range errors, observes fresh access. */
export async function serveFile(
  request: Request,
  bucket: R2Bucket,
  load: () => Promise<StoredFileObject | null>,
  representation: FileRepresentation,
  privateFile = false,
): Promise<Response> {
  const base = privateFile ? adminHeaders : securityHeaders;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { ...base, Allow: "GET, HEAD" },
    });
  if (new URL(request.url).searchParams.size)
    throw new FilesError(400, "Invalid file query.");
  const stored = await load();
  if (
    !stored ||
    (representation !== "download" &&
      stored.receipt.mime === "application/octet-stream")
  )
    notFound();
  const role = representation === "thumbnail" ? "thumbnail" : "source";
  if (stored.descriptor.role !== role) notFound();
  const etag = `"${stored.entry.id}-${role}-${stored.entry.version}"`;
  const headers = new Headers({
    ...base,
    "Content-Type": stored.receipt.mime,
    "Content-Disposition": disposition(
      stored.entry.name,
      representation !== "download",
    ),
    "Content-Security-Policy":
      "default-src 'none'; sandbox; base-uri 'none'; frame-ancestors 'none'",
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": new Date(stored.entry.updatedAt).toUTCString(),
  });
  const fresh = async () => {
    const current = await load();
    if (
      !current ||
      current.entry.version !== stored.entry.version ||
      current.receipt.r2Version !== stored.receipt.r2Version
    )
      notFound();
  };
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch.length > 4096)
    throw new FilesError(400, "Invalid file condition.");
  const notModified =
    ifNoneMatch
      ?.split(",")
      .some(
        (value) =>
          value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
      ) ?? false;
  let selected: ReturnType<typeof range> = null;
  let rangeFailure = false;
  const ifRange = request.headers.get("If-Range");
  if (
    request.method === "GET" &&
    !notModified &&
    (!ifRange || ifRange === etag)
  ) {
    try {
      selected = range(request.headers.get("Range"), stored.receipt.bytes);
    } catch (error) {
      if (!(error instanceof FilesError) || error.status !== 416) throw error;
      rangeFailure = true;
    }
  }
  if (request.method === "HEAD" || notModified || rangeFailure) {
    if (!(await headStoredObject(bucket, stored.descriptor, stored.receipt)))
      notFound();
    await fresh();
    if (rangeFailure) {
      headers.set("Content-Range", `bytes */${stored.receipt.bytes}`);
      return new Response(null, { status: 416, headers });
    }
    if (notModified) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(stored.receipt.bytes));
    return new Response(null, { headers });
  }
  const object = await getStoredObject(
    bucket,
    stored.descriptor,
    stored.receipt,
    selected ?? undefined,
  );
  if (!object) notFound();
  try {
    await fresh();
  } catch (error) {
    await object.body.cancel().catch(() => {});
    throw error;
  }
  headers.set(
    "Content-Length",
    String(selected?.length ?? stored.receipt.bytes),
  );
  if (selected)
    headers.set(
      "Content-Range",
      `bytes ${selected.offset}-${selected.offset + selected.length - 1}/${stored.receipt.bytes}`,
    );
  return new Response(object.body, { status: selected ? 206 : 200, headers });
}

export async function publicFile(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const match = /^\/files\/([^/]+)\/(image|download|thumbnail)$/.exec(
      new URL(request.url).pathname,
    );
    if (!match || !fileIdPattern.test(match[1] ?? "")) notFound();
    const id = match[1] as string;
    const representation = match[2] as FileRepresentation;
    return await serveFile(
      request,
      env.MEDIA,
      () =>
        getPublicFileObject(
          env.DB,
          id,
          representation === "thumbnail" ? "thumbnail" : "source",
        ),
      representation,
    );
  } catch (error) {
    const status = error instanceof FilesError ? error.status : 503;
    const body = JSON.stringify({
      error:
        error instanceof FilesError
          ? error.message
          : "File storage is temporarily unavailable.",
    });
    return new Response(request.method === "HEAD" ? null : body, {
      status,
      headers: {
        ...securityHeaders,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
}
