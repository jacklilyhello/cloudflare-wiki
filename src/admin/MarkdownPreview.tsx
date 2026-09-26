import { useEffect, useRef, useState } from "react";
import type { AuthSession } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import { enhanceTabsets } from "../reader/tabs";
import { ApiError, mutation, request } from "./api";
import "./editor.css";

export function MarkdownPreview({
  markdown,
  language,
  session,
  onExpired,
}: {
  markdown: string;
  language: Language;
  session: AuthSession;
  onExpired?: () => void;
}) {
  const [html, setHtml] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const container = useRef<HTMLDivElement>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    const timer = setTimeout(() => {
      void request<{ html: string }>("preview", {
        ...mutation("POST", { markdown, language }, session.csrfToken),
        signal: controller.signal,
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          setHtml(result.html);
          setState("ready");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setState("error");
          if (error instanceof ApiError && [401, 403].includes(error.status))
            expired.current?.();
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [markdown, language, session.csrfToken]);
  useEffect(() => {
    const node = container.current;
    if (!node || !html) return;
    const restoreTabs = enhanceTabsets(node, language, { preview: true });
    let disposed = false;
    void import("../reader/diagrams")
      .then(({ enhanceDiagrams }) => {
        if (!disposed) return enhanceDiagrams(node, language);
      })
      .catch(() => {
        /* The readable Mermaid source remains visible. */
      });
    const controller = new AbortController();
    const buttons: HTMLButtonElement[] = [];
    for (const anchor of node.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (anchor.getAttribute("href")?.startsWith("#")) continue;
      // Open the rendered link without discarding the in-memory draft.
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    }
    for (const pre of node.querySelectorAll("pre:not(.mermaid-source)")) {
      const code = pre.querySelector("code");
      if (!code || !navigator.clipboard?.writeText) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = language === "zh" ? "复制" : "Copy";
      button.addEventListener(
        "click",
        () => {
          void navigator.clipboard
            .writeText(code.textContent ?? "")
            .then(() => {
              button.textContent = language === "zh" ? "已复制" : "Copied";
            })
            .catch(() => {
              button.textContent =
                language === "zh" ? "请手动复制" : "Select to copy";
            });
        },
        { signal: controller.signal },
      );
      pre.classList.add("has-copy");
      pre.append(button);
      buttons.push(button);
    }
    return () => {
      disposed = true;
      controller.abort();
      for (const button of buttons) button.remove();
      restoreTabs();
    };
  }, [html, language]);
  return (
    <div className="wiki-preview">
      <p className={`wiki-preview-status ${state}`} role="status">
        {state === "loading"
          ? language === "zh"
            ? "正在更新预览…"
            : "Updating preview…"
          : state === "error"
            ? language === "zh"
              ? "预览暂不可用；下方可能是上次结果。请检查内容长度和登录状态。"
              : "Preview unavailable; the previous result may remain below. Check content limits and your session."
            : language === "zh"
              ? "与公开页面使用相同的 Markdown 渲染器"
              : "Uses the same Markdown renderer as the published page"}
      </p>
      {/* This HTML comes only from the authenticated, shared sanitizer endpoint. */}
      <div
        ref={container}
        className="markdown-content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: only the shared server renderer's sanitized HTML reaches this sink.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
