import type { Language } from "./contracts";
import type { SiteSettingsValues } from "./settings";

export const BRAND_ROLES = [
  "logoLight",
  "logoDark",
  "favicon",
  "appleTouch",
  "ogImage",
] as const;
export type BrandRole = (typeof BRAND_ROLES)[number];
export interface BrandAsset {
  path: string;
  sha256: string;
  bytes: number;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}
export interface BrandText {
  name?: string;
  description?: string;
  footer?: string;
  copyright?: string;
}
export interface Branding {
  version: 1;
  assets: Partial<Record<BrandRole, BrandAsset>>;
  locales: Partial<Record<Language, BrandText>>;
}
export const EMPTY_BRANDING: Branding = { version: 1, assets: {}, locales: {} };
export const BRAND_TEXT_LIMITS = {
  name: 80,
  description: 300,
  footer: 500,
  copyright: 200,
} as const;
export const BRAND_WORKER_LIMIT = 5 * 1024;
export function brandingError(): never {
  throw new Error("Invalid deployment branding configuration.");
}
export function brandObject(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    brandingError();
  return value as Record<string, unknown>;
}
export function parseBrandText(value: unknown): Branding["locales"] {
  const input = brandObject(value, ["zh", "en"]);
  const result: Branding["locales"] = {};
  for (const language of ["zh", "en"] as const) {
    if (input[language] === undefined) continue;
    const fields = brandObject(input[language], Object.keys(BRAND_TEXT_LIMITS));
    const text: BrandText = {};
    for (const key of Object.keys(BRAND_TEXT_LIMITS) as (keyof BrandText)[]) {
      const field = fields[key];
      if (field === undefined) continue;
      if (
        typeof field !== "string" ||
        field.length > BRAND_TEXT_LIMITS[key] ||
        [...field].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || (code >= 127 && code <= 159);
        }) ||
        (key === "name" && !field.trim())
      )
        brandingError();
      text[key] = field;
    }
    result[language] = text;
  }
  return result;
}
export function validateBrandAsset(
  role: BrandRole,
  value: unknown,
): BrandAsset {
  const item = brandObject(value, [
    "path",
    "sha256",
    "bytes",
    "mime",
    "width",
    "height",
  ]);
  if (
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !Number.isSafeInteger(item.bytes) ||
    Number(item.bytes) < 1 ||
    Number(item.bytes) > 36 * 1024 ||
    !["image/png", "image/jpeg", "image/webp"].includes(String(item.mime)) ||
    !Number.isSafeInteger(item.width) ||
    !Number.isSafeInteger(item.height) ||
    Number(item.width) < 1 ||
    Number(item.height) < 1 ||
    Number(item.width) > 2048 ||
    Number(item.height) > 2048
  )
    brandingError();
  const ext =
    item.mime === "image/png"
      ? "png"
      : item.mime === "image/jpeg"
        ? "jpg"
        : "webp";
  if (item.path !== `/assets/branding/${role}-${item.sha256}.${ext}`)
    brandingError();
  if (
    (role === "favicon" &&
      (item.mime !== "image/png" || item.width !== 32 || item.height !== 32)) ||
    (role === "appleTouch" &&
      (item.mime !== "image/png" ||
        item.width !== 180 ||
        item.height !== 180)) ||
    (role === "ogImage" &&
      (item.mime === "image/webp" ||
        item.width !== 1200 ||
        item.height !== 630))
  )
    brandingError();
  return item as unknown as BrandAsset;
}
export function parseBranding(value?: string): Branding {
  if (value === undefined || value === "" || value === "{}")
    return { version: 1, assets: {}, locales: {} };
  if (new TextEncoder().encode(value).length > BRAND_WORKER_LIMIT)
    brandingError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    brandingError();
  }
  const input = brandObject(parsed, ["version", "assets", "locales"]);
  if (input.version !== 1) brandingError();
  const assets = brandObject(input.assets, BRAND_ROLES);
  const result: Branding = {
    version: 1,
    assets: {},
    locales: parseBrandText(input.locales),
  };
  for (const role of BRAND_ROLES)
    if (assets[role] !== undefined)
      result.assets[role] = validateBrandAsset(role, assets[role]);
  return result;
}
export function brandSettings(
  settings: SiteSettingsValues,
  branding: Branding,
): SiteSettingsValues {
  const identity = (language: Language) => ({
    name: branding.locales[language]?.name ?? settings.locales[language].name,
    description:
      branding.locales[language]?.description ??
      settings.locales[language].description,
  });
  return { ...settings, locales: { zh: identity("zh"), en: identity("en") } };
}
export function publicOrigin(env: {
  APP_ENV: string;
  PUBLIC_ORIGIN?: string;
}): string {
  const expected =
    env.APP_ENV === "production"
      ? "https://emby.wiki"
      : env.APP_ENV === "test"
        ? "https://cf.emby.wiki"
        : null;
  if (!expected || (env.PUBLIC_ORIGIN && env.PUBLIC_ORIGIN !== expected))
    brandingError();
  return expected;
}
