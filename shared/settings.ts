import type { Language } from "./contracts";

export const SETTINGS_LIMITS = {
  name: 80,
  description: 300,
  body: 4096,
} as const;
export const SITE_THEMES = ["system", "light", "dark"] as const;
export const SITE_ACCENTS = ["forest", "ocean", "plum"] as const;
export const SITE_LOGOS = ["emby", "book", "none"] as const;
export const SETTINGS_FIELDS = [
  "zh.name",
  "zh.description",
  "en.name",
  "en.description",
  "defaultLanguage",
  "theme",
  "accent",
  "logo",
] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];
export type SiteAccent = (typeof SITE_ACCENTS)[number];
export type SiteLogo = (typeof SITE_LOGOS)[number];
export type SettingsField = (typeof SETTINGS_FIELDS)[number];
export interface SiteIdentity {
  name: string;
  description: string;
}
export interface SiteSettingsValues {
  locales: Record<Language, SiteIdentity>;
  defaultLanguage: Language;
  theme: SiteTheme;
  accent: SiteAccent;
  logo: SiteLogo;
}
export interface SiteSettings extends SiteSettingsValues {
  version: number;
  updatedAt: string;
}
export interface SiteSettingsInput extends SiteSettingsValues {
  expectedVersion: number;
}
// Initial values are seeded once by the migration, never a storage-failure fallback.
export const INITIAL_SITE_SETTINGS: SiteSettingsValues = {
  locales: {
    zh: { name: "Emby Wiki", description: "Emby Wiki 技术文档" },
    en: { name: "Emby Wiki", description: "Emby Wiki documentation" },
  },
  defaultLanguage: "zh",
  theme: "system",
  accent: "forest",
  logo: "emby",
};

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error("Invalid site settings.");
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, required: boolean): string {
  if (
    typeof value !== "string" ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    throw new Error("Invalid site settings.");
  const normalized = value.trim();
  if (normalized.length > maximum || (required && !normalized))
    throw new Error("Invalid site settings.");
  return normalized;
}

function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T))
    throw new Error("Invalid site settings.");
  return value as T;
}

/** Shared validation for stored/public settings and explicit administrator input. */
export function parseSiteSettingsValues(value: unknown): SiteSettingsValues {
  const input = object(value, [
    "locales",
    "defaultLanguage",
    "theme",
    "accent",
    "logo",
  ]);
  const locales = object(input.locales, ["zh", "en"]);
  const identity = (value: unknown): SiteIdentity => {
    const fields = object(value, ["name", "description"]);
    return {
      name: text(fields.name, SETTINGS_LIMITS.name, true),
      description: text(fields.description, SETTINGS_LIMITS.description, false),
    };
  };
  return {
    locales: { zh: identity(locales.zh), en: identity(locales.en) },
    defaultLanguage: choice(input.defaultLanguage, ["zh", "en"]),
    theme: choice(input.theme, SITE_THEMES),
    accent: choice(input.accent, SITE_ACCENTS),
    logo: choice(input.logo, SITE_LOGOS),
  };
}
