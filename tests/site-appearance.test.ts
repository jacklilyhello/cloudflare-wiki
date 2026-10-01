import { afterEach, expect, it, vi } from "vitest";
import { INITIAL_SITE_SETTINGS } from "../shared/settings";
import { applySiteAppearance, toggleSiteTheme } from "../src/site-appearance";

afterEach(() => vi.unstubAllGlobals());

it("uses one stored preference for cover and reader, including refresh, system fallback and blocked storage", () => {
  const dataset = { theme: "system", accent: "forest" };
  const meta = { dataset: { light: "#f5f4ee", dark: "#091410" }, content: "" };
  let saved: string | null = null;
  let blocked = false;
  vi.stubGlobal("document", {
    documentElement: { dataset },
    querySelector: () => meta,
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("localStorage", {
    getItem: () => {
      if (blocked) throw new Error("Unavailable");
      return saved;
    },
    setItem: (_key: string, value: string) => {
      if (blocked) throw new Error("Unavailable");
      saved = value;
    },
  });
  expect(applySiteAppearance(INITIAL_SITE_SETTINGS)).toBe("dark");
  expect(dataset.theme).toBe("system");
  expect(meta.content).toBe(meta.dataset.dark);
  toggleSiteTheme(INITIAL_SITE_SETTINGS);
  expect(saved).toBe("light");
  expect(dataset.theme).toBe("light");
  expect(meta.content).toBe(meta.dataset.light);
  expect(applySiteAppearance({ ...INITIAL_SITE_SETTINGS, theme: "dark" })).toBe(
    "light",
  );
  saved = "invalid";
  expect(
    applySiteAppearance({ ...INITIAL_SITE_SETTINGS, theme: "light" }),
  ).toBe("light");
  blocked = true;
  expect(applySiteAppearance(INITIAL_SITE_SETTINGS)).toBe("dark");
  expect(() => toggleSiteTheme(INITIAL_SITE_SETTINGS)).not.toThrow();
  expect(dataset.theme).toBe("light");
  expect(meta.content).toBe(meta.dataset.light);
});
