import { PUBLIC_DOMAINS } from "./deploy-policy.mjs";

export const LOCAL_SMOKE_BASE_URL = "http://127.0.0.1:4173";

export function validateSmokeBaseUrl(base) {
  const allowedBases = new Set([
    LOCAL_SMOKE_BASE_URL,
    ...PUBLIC_DOMAINS.map((domain) => `https://${domain}`),
  ]);
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Smoke test base URL must be a valid URL.");
  }
  if (url.origin !== base || !allowedBases.has(base)) {
    throw new Error(
      "Smoke tests are restricted to localhost and the three fixed production Custom Domains.",
    );
  }
  return url;
}

export function createSmokeGet(
  base,
  transport = fetch,
  aliasTransport = fetch,
) {
  const origin = validateSmokeBaseUrl(base).origin;
  return async (path, options = {}) => {
    const requested = new URL(path, origin);
    if (requested.origin !== origin || requested.username || requested.password)
      throw new Error(
        "Smoke requests must remain on the selected public origin.",
      );
    if (options.method && options.method !== "GET")
      throw new Error("Smoke requests are anonymous GETs only.");
    const headers = new Headers(options.headers);
    if (headers.has("authorization") || headers.has("cookie"))
      throw new Error(
        "Smoke requests cannot supply authentication credentials.",
      );
    const target = new URL(requested);
    if (origin === "https://www.emby.wiki") {
      const alias = await aliasTransport(requested, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      target.hostname = "emby.wiki";
      if (alias.status !== 301 || alias.headers.get("location") !== target.href)
        throw new Error(
          "WWW must redirect only to the same production path and query.",
        );
      await alias.body?.cancel();
    }
    const response = await transport(target, {
      signal: AbortSignal.timeout(15_000),
      ...options,
      method: "GET",
      redirect: "manual",
    });
    if (
      options.redirect !== "manual" &&
      [301, 302, 303, 307, 308].includes(response.status)
    )
      throw new Error(
        "Unexpected application redirect during production smoke.",
      );
    return response;
  };
}
