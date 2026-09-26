import { effectiveTheme } from "../site-appearance";

type EditorTheme = "wiki-paper" | "wiki-night";
interface ThemeSource {
  theme(): unknown;
  systemDark(): boolean;
  observe(changed: () => void): () => void;
}

// Monaco themes are global. Concurrent editor/diff instances share one watcher,
// and the last instance releases it. Nothing here changes an editor's model.
export function createMonacoThemeBinding(
  source: ThemeSource,
  apply: (theme: EditorTheme) => void,
): () => () => void {
  let users = 0;
  let generation = 0;
  let stop: (() => void) | undefined;
  let update: (() => void) | undefined;
  let previous: EditorTheme | undefined;
  return () => {
    if (users === 0) {
      users = 1;
      const current = ++generation;
      update = () => {
        if (users === 0 || generation !== current) return;
        // The document attribute already includes the saved visitor override.
        const theme =
          effectiveTheme("system", source.theme(), source.systemDark()) ===
          "dark"
            ? "wiki-night"
            : "wiki-paper";
        if (theme === previous) return;
        apply(theme);
        previous = theme;
      };
      try {
        stop = source.observe(update);
        update();
      } catch (error) {
        users = 0;
        generation++;
        const dispose = stop;
        stop = undefined;
        update = undefined;
        previous = undefined;
        dispose?.();
        throw error;
      }
    } else {
      update?.();
      users++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      users--;
      if (users !== 0) return;
      generation++;
      const dispose = stop;
      stop = undefined;
      update = undefined;
      previous = undefined;
      dispose?.();
    };
  };
}
