import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  BRAND_ROLES,
  brandObject,
  parseBranding,
  parseBrandText,
  validateBrandAsset,
} from "../shared/branding.ts";

export const BRAND_VARIABLES = Object.freeze({
  logoLight: "WIKI_BRAND_LOGO_LIGHT_B64",
  logoDark: "WIKI_BRAND_LOGO_DARK_B64",
  favicon: "WIKI_BRAND_FAVICON_B64",
  appleTouch: "WIKI_BRAND_APPLE_TOUCH_B64",
  ogImage: "WIKI_BRAND_OG_IMAGE_B64",
});
export const MANIFEST_VARIABLE = "WIKI_BRAND_MANIFEST";
export const VARIABLE_LIMIT = 48 * 1024;
export const VARIABLES_LIMIT = 256 * 1024;
export class BrandingError extends Error {}
export function fail(
  message = "Invalid branding input; check image formats, dimensions, hashes and configured limits.",
) {
  throw new BrandingError(message);
}
export function checkVariableLimits(variables) {
  let total = 0;
  for (const [name, value] of Object.entries(variables)) {
    if (typeof value !== "string" || Buffer.byteLength(value) > VARIABLE_LIMIT)
      fail("A Repository Variable exceeds 48 KiB or is invalid.");
    total += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (total > VARIABLES_LIMIT)
    fail("Repository Variables exceed the 256 KiB combined limit.");
  return total;
}
export async function inspectBrandImage(role, bytes) {
  try {
    if (
      !BRAND_ROLES.includes(role) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length < 1 ||
      bytes.length > 36 * 1024
    )
      fail();
    const format = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        ? "jpeg"
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          ? "webp"
          : null;
    if (!format) fail();
    if (format === "png") {
      let offset = 8;
      let ended = false;
      while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        if (length > bytes.length - offset - 12 || type === "acTL") fail();
        offset += length + 12;
        if (type === "IEND") {
          ended = length === 0 && offset === bytes.length;
          break;
        }
      }
      if (!ended) fail();
    }
    if (
      format === "webp" &&
      (bytes.readUInt32LE(4) + 8 !== bytes.length ||
        (bytes.toString("ascii", 12, 16) === "VP8X" && (bytes[20] & 2) !== 0))
    )
      fail();
    const image = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 2048 * 2048,
      animated: true,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== format ||
      (metadata.pages ?? 1) !== 1 ||
      (metadata.orientation ?? 1) !== 1
    )
      fail();
    await image.raw().toBuffer(); // Decode every pixel; headers alone do not prove a valid image.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ext = format === "jpeg" ? "jpg" : format;
    return validateBrandAsset(role, {
      path: `/assets/branding/${role}-${sha256}.${ext}`,
      sha256,
      bytes: bytes.length,
      mime: `image/${format}`,
      width: metadata.width,
      height: metadata.height,
    });
  } catch {
    fail();
  }
}
export async function encodeBranding(input, readImage) {
  try {
    const config = brandObject(input, ["assets", "locales"]);
    const images = brandObject(config.assets ?? {}, BRAND_ROLES);
    const branding = {
      version: 1,
      assets: {},
      locales: parseBrandText(config.locales ?? {}),
    };
    const variables = {};
    for (const role of BRAND_ROLES) {
      if (images[role] === undefined) continue;
      if (
        typeof images[role] !== "string" ||
        !images[role] ||
        /^[a-z]+:\/\//i.test(images[role])
      )
        fail();
      const bytes = await readImage(images[role]);
      branding.assets[role] = await inspectBrandImage(role, bytes);
      variables[BRAND_VARIABLES[role]] = bytes.toString("base64");
    }
    variables[MANIFEST_VARIABLE] = JSON.stringify(branding);
    parseBranding(variables[MANIFEST_VARIABLE]);
    checkVariableLimits(variables);
    return variables;
  } catch (error) {
    if (error instanceof BrandingError) throw error;
    fail(
      "Branding manifest is invalid or exceeds the 5 KiB Worker variable limit.",
    );
  }
}
export async function decodeBranding(variables) {
  if (
    !variables ||
    typeof variables !== "object" ||
    Array.isArray(variables) ||
    Object.keys(variables).some(
      (name) =>
        ![MANIFEST_VARIABLE, ...Object.values(BRAND_VARIABLES)].includes(name),
    )
  )
    fail("Unknown branding Repository Variable.");
  checkVariableLimits(variables);
  try {
    const manifest = variables[MANIFEST_VARIABLE] ?? "";
    const active = Object.values(BRAND_VARIABLES).some(
      (name) => variables[name],
    );
    if (!manifest && active)
      fail(
        "Images require a matching WIKI_BRAND_MANIFEST; nothing was deployed.",
      );
    const branding = parseBranding(manifest);
    const files = [];
    for (const role of BRAND_ROLES) {
      const value = variables[BRAND_VARIABLES[role]] ?? "";
      const asset = branding.assets[role];
      if (Boolean(value) !== Boolean(asset))
        fail(
          "Branding image/manifest mismatch; check missing or truncated Repository Variables.",
        );
      if (!asset) continue;
      const bytes = Buffer.from(value, "base64");
      if (bytes.toString("base64") !== value)
        fail(
          "Branding requires canonical Base64 without whitespace or data-URL prefixes.",
        );
      const inspected = await inspectBrandImage(role, bytes);
      if (Object.keys(inspected).some((key) => inspected[key] !== asset[key]))
        fail("Branding bytes do not match the manifest.");
      files.push({ asset, bytes });
    }
    return { branding, files };
  } catch (error) {
    if (error instanceof BrandingError) throw error;
    fail(
      "Branding manifest is invalid or exceeds the 5 KiB Worker variable limit.",
    );
  }
}
