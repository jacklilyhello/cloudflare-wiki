import { useEffect } from "react";
import type { Language } from "../../shared/contracts";
import type { SiteSettingsValues } from "../../shared/settings";
import { applySiteAppearance, toggleSiteTheme } from "../site-appearance";
import { Icon } from "./Icon";

export function ThemeToggle({
  settings,
  language,
}: {
  settings: SiteSettingsValues;
  language: Language;
}) {
  const label = language === "zh" ? "切换明暗主题" : "Switch color theme";
  useEffect(() => {
    applySiteAppearance(settings);
    const update = (event: StorageEvent) => {
      if (event.key === "wiki-theme" || event.key === null)
        applySiteAppearance(settings);
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [settings]);
  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={() => toggleSiteTheme(settings)}
      aria-label={label}
      title={label}
    >
      <Icon name="moon" className="theme-moon" />
      <Icon name="sun" className="theme-sun" />
    </button>
  );
}
