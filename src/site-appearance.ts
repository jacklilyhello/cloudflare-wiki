import type { SiteSettingsValues, SiteTheme } from "../shared/settings";

export function updateThemeColor(theme: "light" | "dark") {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"][data-light][data-dark]',
  );
  if (meta) meta.content = meta.dataset[theme] ?? meta.content;
}

export function toggleSiteTheme(settings: SiteSettingsValues) {
  const current = effectiveTheme(
    settings.theme,
    document.documentElement.dataset.theme,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  updateThemeColor(next);
  try {
    localStorage.setItem("wiki-theme", next);
  } catch {
    // The current theme does not require persistent storage.
  }
}

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
  const theme = effectiveTheme(
    settings.theme,
    saved,
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  updateThemeColor(theme);
  return theme;
}
