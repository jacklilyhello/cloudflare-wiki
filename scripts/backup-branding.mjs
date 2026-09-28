import { parseBranding } from "../shared/branding.ts";
import { fail, sha256 } from "./backup-format.mjs";
import { boundedBytes } from "./backup-r2.mjs";
import {
  BRAND_VARIABLES,
  decodeBranding,
  MANIFEST_VARIABLE,
} from "./branding-config.mjs";

export async function captureBranding(settings, fetchRequest = fetch) {
  const matches =
    settings.bindings?.filter((binding) => binding.name === "BRANDING_JSON") ??
    [];
  if (
    matches.length > 1 ||
    (matches.length === 1 && matches[0].type !== "plain_text")
  )
    fail("Deployed branding binding is invalid.");
  const branding = parseBranding(matches[0]?.text);
  const variables = { [MANIFEST_VARIABLE]: JSON.stringify(branding) };
  for (const [role, asset] of Object.entries(branding.assets)) {
    const response = await fetchRequest(`https://cf.emby.wiki${asset.path}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { "Cache-Control": "no-cache" },
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      response.headers.get("content-type")?.split(";")[0] !== asset.mime
    ) {
      await response.body?.cancel();
      fail("Deployed branding asset is unavailable.");
    }
    const bytes = await boundedBytes(response, 36 * 1024);
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
      fail("Deployed branding asset checksum differs.");
    variables[BRAND_VARIABLES[role]] = bytes.toString("base64");
  }
  await decodeBranding(variables);
  return variables;
}
