import { useEffect, useRef, useState } from "react";
import type { Language } from "../../shared/contracts";
import { monaco, retainMonacoTheme } from "./monaco";
import "./editor.css";

export function MarkdownDiff({
  original,
  modified,
  language,
}: {
  original: string;
  modified: string;
  language: Language;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    let left: monaco.editor.ITextModel | undefined;
    let right: monaco.editor.ITextModel | undefined;
    let instance: monaco.editor.IStandaloneDiffEditor | undefined;
    let releaseTheme: (() => void) | undefined;
    const dispose = () => {
      try {
        instance?.dispose();
      } finally {
        try {
          left?.dispose();
        } finally {
          try {
            right?.dispose();
          } finally {
            releaseTheme?.();
          }
        }
      }
    };
    try {
      releaseTheme = retainMonacoTheme();
      left = monaco.editor.createModel(original, "markdown");
      right = monaco.editor.createModel(modified, "markdown");
      instance = monaco.editor.createDiffEditor(container.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        minimap: { enabled: false },
        wordWrap: "on",
        scrollBeyondLastLine: false,
        links: false,
        originalAriaLabel: language === "zh" ? "原始版本" : "Original revision",
        modifiedAriaLabel: language === "zh" ? "修改版本" : "Modified revision",
        ariaLabel:
          language === "zh"
            ? "Markdown 版本差异"
            : "Markdown revision comparison",
      });
      instance.setModel({ original: left, modified: right });
      setError(false);
    } catch {
      dispose();
      setError(true);
      return;
    }
    return dispose;
  }, [original, modified, language]);
  return (
    <>
      {error && (
        <p className="admin-notice error" role="alert">
          {language === "zh"
            ? "对比编辑器未能加载，请刷新页面。"
            : "The comparison editor could not load. Reload this page."}
        </p>
      )}
      <div className="wiki-markdown-diff" ref={container} />
    </>
  );
}
