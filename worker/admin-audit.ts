import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_LIMITS,
  type AuditListOptions,
} from "../shared/audit";
import type { AuthSession } from "../shared/auth";
import { json } from "./admin-http";
import { AuditError, AuditService } from "./audit/service";
import { sha256 } from "./auth/crypto";

const queryFields = [
  "category",
  "action",
  "language",
  "subjectId",
  "from",
  "to",
  "cursor",
  "limit",
];

function choice<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  if (value === null) return undefined;
  if (!allowed.includes(value as T))
    throw new AuditError(400, "Invalid audit filter.");
  return value as T;
}

// This dispatcher receives an authenticated session from adminApi. AuditService
// independently checks the same session identity in each private SQL read.
export async function adminAudit(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/audit") return null;
  if (request.method !== "GET")
    return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!queryFields.includes(key) || seen.has(key))
      throw new AuditError(400, "Invalid audit query.");
    seen.add(key);
  }
  const params = url.searchParams;
  const options: AuditListOptions = {
    category: choice(params.get("category"), AUDIT_CATEGORIES),
    action: choice(params.get("action"), AUDIT_ACTIONS),
    language: choice(params.get("language"), ["zh", "en", "site"] as const),
  };
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > AUDIT_LIMITS.page)
      throw new AuditError(400, "Invalid audit page size.");
    options.limit = Number(limit);
  }
  const subjectId = params.get("subjectId");
  if (subjectId !== null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(subjectId))
      throw new AuditError(400, "Invalid audit subject.");
    options.subjectId = subjectId;
  }
  for (const key of ["from", "to", "cursor"] as const) {
    const value = params.get(key);
    if (value !== null) options[key] = value;
  }
  const service = new AuditService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  return json(await service.list(options));
}
