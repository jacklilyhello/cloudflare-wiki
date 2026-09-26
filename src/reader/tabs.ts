import type { Language } from "../../shared/contracts";

/** Horizontal tabs leave vertical arrows and modified keys to the browser. */
export function tabSelectionForKey(
  key: string,
  current: number,
  count: number,
): number | null {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= count
  )
    return null;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Resolve only this document's fragment; previews accept fragment-only links. */
export function tabFragmentId(
  href: string,
  location: string,
  preview = false,
): string | null {
  if (preview && !href.startsWith("#")) return null;
  try {
    const current = new URL(location);
    const target = new URL(href, current);
    if (
      target.origin !== current.origin ||
      target.pathname !== current.pathname ||
      target.search !== current.search ||
      !target.hash
    )
      return null;
    return decodeURIComponent(target.hash.slice(1)) || null;
  } catch {
    return null;
  }
}

type Tab = {
  details: HTMLDetailsElement;
  summary: HTMLElement;
  marker: Comment;
  panel: HTMLDivElement;
  button: HTMLButtonElement;
};
type Group = {
  section: HTMLElement;
  list: HTMLDivElement;
  tabs: Tab[];
};
const enhanced = new WeakSet<HTMLElement>();
let sequence = 0;

function select(group: Group, index: number, focus = false) {
  for (const [position, tab] of group.tabs.entries()) {
    const active = position === index;
    tab.button.setAttribute("aria-selected", String(active));
    tab.button.tabIndex = active ? 0 : -1;
    tab.panel.hidden = !active;
  }
  if (focus) group.tabs[index]?.button.focus();
}

function restore(group: Group) {
  for (const tab of group.tabs) {
    // Restore these exact nodes, even if React has already detached the old
    // preview. Never replace root.innerHTML or inspect a newer render here.
    while (tab.panel.firstChild) tab.details.appendChild(tab.panel.firstChild);
    tab.marker.replaceWith(tab.summary);
    if (tab.panel.parentNode) tab.panel.replaceWith(tab.details);
  }
  group.list.remove();
  group.section.classList.remove("wiki-tabs-enhanced");
  enhanced.delete(group.section);
}

/** Enhance only sanitizer-proven tabset classes; return an idempotent disposer. */
export function enhanceTabsets(
  root: HTMLElement,
  language: Language,
  options: { preview?: boolean } = {},
): () => void {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) return () => {};
  const window = view;
  const events = new AbortController();
  const groups: Group[] = [];
  // Snapshot in document order: outer groups are selected before nested groups.
  for (const section of root.querySelectorAll<HTMLElement>(
    "section.wiki-tabs",
  )) {
    if (enhanced.has(section)) continue;
    const disclosures = [...section.children].filter(
      (child): child is HTMLDetailsElement =>
        child.tagName === "DETAILS" && child.classList.contains("wiki-tab"),
    );
    if (
      !disclosures.length ||
      disclosures.some(
        (child) => child.firstElementChild?.tagName !== "SUMMARY",
      )
    )
      continue;
    const initial = Math.max(
      0,
      disclosures.findIndex((child) => child.open),
    );
    const id = `wiki-tabset-${++sequence}`;
    const list = document.createElement("div");
    list.className = "wiki-tab-list";
    list.setAttribute("role", "tablist");
    list.setAttribute(
      "aria-label",
      language === "zh" ? "内容选项" : "Content options",
    );
    const group: Group = { section, list, tabs: [] };
    try {
      for (const [index, details] of disclosures.entries()) {
        const summary = details.firstElementChild as HTMLElement;
        const label =
          summary.textContent?.trim() ||
          `${language === "zh" ? "选项" : "Tab"} ${index + 1}`;
        const button = document.createElement("button");
        button.type = "button";
        button.id = `${id}-tab-${index}`;
        button.className = "wiki-tab-trigger";
        button.textContent = label;
        button.setAttribute("role", "tab");
        const panel = document.createElement("div");
        panel.id = `${id}-panel-${index}`;
        panel.className = "wiki-tab-panel";
        panel.dataset.tabLabel = label;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", button.id);
        panel.tabIndex = 0;
        button.setAttribute("aria-controls", panel.id);
        const marker = document.createComment("tab label");
        group.tabs.push({ details, summary, marker, panel, button });
        summary.replaceWith(marker);
        while (details.firstChild) panel.appendChild(details.firstChild);
        details.replaceWith(panel);
        list.appendChild(button);
        button.addEventListener("click", () => select(group, index, true), {
          signal: events.signal,
        });
        button.addEventListener("focus", () => select(group, index), {
          signal: events.signal,
        });
        button.addEventListener(
          "keydown",
          (event) => {
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            const next = tabSelectionForKey(
              event.key,
              index,
              group.tabs.length,
            );
            if (next === null) return;
            event.preventDefault();
            select(group, next, true);
          },
          { signal: events.signal },
        );
      }
      section.insertBefore(list, group.tabs[0]?.panel ?? null);
      select(group, initial);
      section.classList.add("wiki-tabs-enhanced");
      enhanced.add(section);
      groups.push(group);
    } catch {
      // A failed enhancement keeps the native disclosure content available.
      restore(group);
    }
  }

  if (!groups.length && !options.preview) {
    events.abort();
    return () => {};
  }
  function target(id: string) {
    return [...root.querySelectorAll<HTMLElement>("[id]")].find(
      (node) => node.id === id,
    );
  }
  function reveal(node: HTMLElement) {
    let found = false;
    for (const group of groups) {
      if (!root.contains(group.section)) continue;
      const index = group.tabs.findIndex((tab) => tab.panel.contains(node));
      if (index >= 0) {
        select(group, index);
        found = true;
      }
    }
    return found;
  }
  function revealHash() {
    const id = tabFragmentId(window.location.hash, window.location.href);
    const node = id ? target(id) : undefined;
    if (node && reveal(node)) node.scrollIntoView({ block: "start" });
  }
  const clickRoot = options.preview ? root : document;
  clickRoot.addEventListener(
    "click",
    (event) => {
      if (
        !(event instanceof MouseEvent) ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !anchor ||
        (anchor.target && anchor.target !== "_self") ||
        anchor.hasAttribute("download")
      )
        return;
      const id = tabFragmentId(
        anchor.getAttribute("href") ?? "",
        window.location.href,
        options.preview,
      );
      const node = id ? target(id) : undefined;
      if (!node) return;
      reveal(node);
      if (options.preview) {
        // Keep the editor URL and draft in place; fragment navigation stays inside
        // this preview instead of targeting similarly named reader/shell elements.
        event.preventDefault();
        node.scrollIntoView({ block: "start" });
      }
    },
    { signal: events.signal },
  );
  if (!options.preview && groups.length) {
    window.addEventListener("hashchange", revealHash, {
      signal: events.signal,
    });
    revealHash();
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    events.abort();
    for (const group of groups.reverse()) restore(group);
  };
}
