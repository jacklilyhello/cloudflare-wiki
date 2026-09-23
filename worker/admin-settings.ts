import type { AuthSession } from "../shared/auth";
import { SETTINGS_LIMITS, type SiteSettingsInput } from "../shared/settings";
import { csrf, json, readJson, sameOrigin } from "./admin-http";
import { sha256 } from "./auth/crypto";
import { SettingsError, SettingsService } from "./settings/service";

export async function adminSettings(
  request: Request,
  env: Env,
  session: AuthSession,
  rawToken: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/admin/settings") return null;
  if (url.searchParams.size)
    throw new SettingsError(400, "Invalid settings query.");
  if (request.method !== "GET" && request.method !== "PUT")
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  const service = new SettingsService(env.DB, {
    tokenHash: await sha256(rawToken),
    authVersion: session.user.version,
  });
  if (request.method === "GET") return json(await service.get());
  sameOrigin(request);
  csrf(request, session);
  const input = await readJson(request, SETTINGS_LIMITS.body);
  // The service validates this unknown JSON and its exact nested schema.
  return json(await service.update(input as unknown as SiteSettingsInput));
}
