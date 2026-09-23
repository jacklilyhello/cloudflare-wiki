// Runs before styles and first paint; only a fixed visitor preference can
// override the validated site theme already rendered on the document.
try {
  const saved = localStorage.getItem("wiki-theme");
  if (saved === "light" || saved === "dark")
    document.documentElement.dataset.theme = saved;
} catch {
  // Keep the server-rendered preference when browser storage is disabled.
}
