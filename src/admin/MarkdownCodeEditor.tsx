import { useEffect, useRef } from "react";
import type { Language } from "../../shared/contracts";
import { monaco } from "./monaco";

export type EditorHandle = monaco.editor.IStandaloneCodeEditor;

export function MarkdownCodeEditor({
  value,
  onChange,
  readOnly,
  language,
  onReady,
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  language: Language;
  onReady: (editor: EditorHandle | null) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const callbacks = useRef({ onChange, onReady });
  callbacks.current = { onChange, onReady };
  const initialValue = useRef(value);
  useEffect(() => {
    if (!element.current) return;
    const model = monaco.editor.createModel(initialValue.current, "markdown");
    const instance = monaco.editor.create(element.current, {
      model,
      theme: "wiki-paper",
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: "on",
      fontSize: 14,
      lineHeight: 24,
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      padding: { top: 16, bottom: 24 },
      links: false,
      renderWhitespace: "selection",
      tabSize: 2,
      stickyScroll: { enabled: false },
    });
    editor.current = instance;
    const listener = model.onDidChangeContent(() =>
      callbacks.current.onChange(model.getValue()),
    );
    callbacks.current.onReady(instance);
    return () => {
      callbacks.current.onReady(null);
      listener.dispose();
      instance.dispose();
      model.dispose();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);
  useEffect(() => {
    editor.current?.updateOptions({
      readOnly,
      ariaLabel:
        language === "zh" ? "Markdown 正文编辑器" : "Markdown document editor",
    });
  }, [readOnly, language]);
  return <div ref={element} className="wiki-code-editor" />;
}
