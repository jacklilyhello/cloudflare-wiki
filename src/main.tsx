import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import type { ReaderData } from "../shared/reader";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
const readerData = document.getElementById("reader-data");
if (!root || !readerData?.textContent)
  throw new Error("Missing reader document");
const data = JSON.parse(readerData.textContent) as ReaderData;

// An external module applies saved preferences without relaxing script CSP.
try {
  const theme = localStorage.getItem("wiki-theme");
  if (theme === "light" || theme === "dark")
    document.documentElement.dataset.theme = theme;
} catch {
  /* System theme remains available when browser storage is disabled. */
}

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
