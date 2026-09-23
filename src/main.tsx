import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import type { ReaderData } from "../shared/reader";
import { parseSiteSettingsValues } from "../shared/settings";
import { App } from "./App";
import { applySiteAppearance } from "./site-appearance";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

if (
  window.location.pathname === "/admin" ||
  window.location.pathname.startsWith("/admin/")
) {
  const settingsElement = document.getElementById("site-settings");
  if (!settingsElement?.textContent) throw new Error("Missing site settings");
  const settings = parseSiteSettingsValues(
    JSON.parse(settingsElement.textContent),
  );
  applySiteAppearance(settings);
  void import("./admin/AdminApp")
    .then(({ AdminApp }) => {
      createRoot(root).render(
        <StrictMode>
          <AdminApp settings={settings} />
        </StrictMode>,
      );
    })
    .catch(() => {
      root.textContent =
        "管理界面加载失败，请刷新重试。 / Please reload to try again.";
    });
} else {
  const readerData = document.getElementById("reader-data");
  if (!readerData?.textContent) throw new Error("Missing reader document");
  const data = JSON.parse(readerData.textContent) as ReaderData;
  data.settings = parseSiteSettingsValues(data.settings);
  applySiteAppearance(data.settings);
  hydrateRoot(
    root,
    <StrictMode>
      <App data={data} />
    </StrictMode>,
  );

  // Diagram code stays out of the server bundle and is loaded only when needed.
  setTimeout(() => {
    const article = document.querySelector<HTMLElement>(".markdown-content");
    if (article?.querySelector(".mermaid-source")) {
      void import("./reader/diagrams")
        .then(({ enhanceDiagrams }) => enhanceDiagrams(article, data.language))
        .catch(() => {
          /* Readable diagram source remains available if enhancement fails. */
        });
    }
  }, 0);
}
