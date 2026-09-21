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

export { monaco };
