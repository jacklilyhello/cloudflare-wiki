import type { SiteSettingsValues, SiteTheme } from "../shared/settings";

export function effectiveTheme(
  theme: SiteTheme,
  saved: unknown,
  systemDark: boolean,
): "light" | "dark" {
  if (saved === "light" || saved === "dark") return saved;
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

export function applySiteAppearance(
  settings: SiteSettingsValues,
): "light" | "dark" {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("wiki-theme");
  } catch {
    // A browser that disables storage still follows the configured theme.
  }
  document.documentElement.dataset.theme =
    saved === "light" || saved === "dark" ? saved : settings.theme;
  document.documentElement.dataset.accent = settings.accent;
  return effectiveTheme(
    settings.theme,
    saved,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}
