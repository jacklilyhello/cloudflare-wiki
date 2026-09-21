import { timingSafeEqual } from "node:crypto";
import type { AuthSession } from "../shared/auth";
import { AuthError } from "./auth/service";
import { securityHeaders } from "./security";

export const adminHeaders = { ...securityHeaders, Vary: "Cookie, Origin" };
const encoder = new TextEncoder();

export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(value, {
    status,
    headers: { ...adminHeaders, ...headers },
  });
}

export function sameOrigin(request: Request) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (
    request.headers.get("Origin") !== new URL(request.url).origin ||
    (site !== null && site !== "same-origin" && site !== "none")
  )
    throw new AuthError(403, "This request must come from this site.");
}

export function csrf(request: Request, session: AuthSession) {
  const supplied = encoder.encode(request.headers.get("X-CSRF-Token") ?? "");
  const expected = encoder.encode(session.csrfToken);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new AuthError(403, "Invalid request token. Reload and try again.");
}

export async function readJson(
  request: Request,
  maxBytes = 4096,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new AuthError(400, "A JSON request is required.");
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes)
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
      if (length > maxBytes) {
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
