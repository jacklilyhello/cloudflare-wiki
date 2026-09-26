import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/tokenization/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/codicon/register";
import "monaco-editor/languages/definitions/markdown/register";
import { createMonacoThemeBinding } from "./monaco-theme";

// A bundled same-origin worker; never a CDN, blob loader, or eval fallback.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme("wiki-paper", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#25382e",
    "editorLineNumber.foreground": "#a0ada4",
    "editorLineNumber.activeForeground": "#267349",
    "editor.selectionBackground": "#d9ebdf",
    "editor.lineHighlightBackground": "#f7faf7",
  },
});

monaco.editor.defineTheme("wiki-night", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#202824",
    "editor.foreground": "#e2e9e3",
    "editorLineNumber.foreground": "#84958a",
    "editorLineNumber.activeForeground": "#8ccca7",
    "editor.selectionBackground": "#365443",
    "editor.inactiveSelectionBackground": "#2b4033",
    "editor.lineHighlightBackground": "#253029",
    "editorCursor.foreground": "#cce6d5",
    "editorGutter.background": "#202824",
    "editorWidget.background": "#1c2320",
    "editorWidget.border": "#303b34",
  },
});

export const retainMonacoTheme = createMonacoThemeBinding(
  {
    theme: () => document.documentElement.dataset.theme,
    systemDark: () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    observe(changed) {
      const preference = window.matchMedia("(prefers-color-scheme: dark)");
      const observer = new MutationObserver(changed);
      const dispose = () => {
        observer.disconnect();
        preference.removeEventListener("change", changed);
      };
      try {
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        preference.addEventListener("change", changed);
      } catch (error) {
        dispose();
        throw error;
      }
      return dispose;
    },
  },
  (theme) => monaco.editor.setTheme(theme),
);

export { monaco };
