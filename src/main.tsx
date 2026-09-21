import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import type { ReaderData } from "../shared/reader";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

// An external module applies saved preferences without relaxing script CSP.
try {
  const theme = localStorage.getItem("wiki-theme");
  if (theme === "light" || theme === "dark")
    document.documentElement.dataset.theme = theme;
} catch {
  /* System theme remains available when browser storage is disabled. */
}

if (
  window.location.pathname === "/admin" ||
  window.location.pathname.startsWith("/admin/")
) {
  void import("./admin/AdminApp")
    .then(({ AdminApp }) => {
      createRoot(root).render(
        <StrictMode>
          <AdminApp />
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
