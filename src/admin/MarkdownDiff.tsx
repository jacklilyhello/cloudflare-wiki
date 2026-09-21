import { useEffect, useRef, useState } from "react";
import type { Language } from "../../shared/contracts";
import { monaco } from "./monaco";
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
    const left = monaco.editor.createModel(original, "markdown");
    const right = monaco.editor.createModel(modified, "markdown");
    let instance: monaco.editor.IStandaloneDiffEditor | undefined;
    try {
      instance = monaco.editor.createDiffEditor(container.current, {
        theme: "wiki-paper",
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
      setError(true);
    }
    return () => {
      instance?.dispose();
      left.dispose();
      right.dispose();
    };
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
