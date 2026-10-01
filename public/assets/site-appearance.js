// Runs before styles and first paint; only a fixed visitor preference can
// override the validated site theme already rendered on the document.
try {
  const saved = localStorage.getItem("wiki-theme");
  if (saved === "light" || saved === "dark")
    document.documentElement.dataset.theme = saved;
} catch {
  // Keep the server-rendered preference when browser storage is disabled.
}

// Theme metadata precedes this script. CSS resolves system mode before paint;
// the browser chrome follows the same preference, including later OS changes.
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
function updateThemeColor() {
  const meta = document.querySelector(
    'meta[name="theme-color"][data-light][data-dark]',
  );
  const preference = document.documentElement.dataset.theme;
  const theme =
    preference === "system"
      ? systemTheme.matches
        ? "dark"
        : "light"
      : preference;
  if (meta && (theme === "light" || theme === "dark"))
    meta.content = meta.dataset[theme];
}
updateThemeColor();
systemTheme.addEventListener("change", updateThemeColor);
