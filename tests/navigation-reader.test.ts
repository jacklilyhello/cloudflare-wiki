import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NavigationEntry, ReaderData } from "../shared/reader";
import { INITIAL_SITE_SETTINGS } from "../shared/settings";
import { App } from "../src/App";

function render(navigation: NavigationEntry[]) {
  const data: ReaderData = {
    settings: INITIAL_SITE_SETTINGS,
    language: "en",
    page: {
      id: "current-en",
      translationId: "current",
      language: "en",
      path: "current",
      title: "Current article",
      description: "Public description",
      markdown: "Visible body",
      tags: [],
      updatedAt: "2026-09-21T00:00:00.000Z",
    },
    rendered: { html: "<p>Visible body</p>", toc: [] },
    navigation,
    translations: { en: "/en/current" },
    mode: "article",
    searchQuery: "",
    searchResults: [],
  };
  return renderToString(createElement(App, { data }));
}

function page(id: string, title: string): NavigationEntry {
  return { id, kind: "page", external: false, title, path: `/en/${id}` };
}

describe("reader custom navigation", () => {
  it("opens the active group and uses only internal pages for adjacent reading", () => {
    const html = render([
      page("previous", "Previous article"),
      {
        id: "group",
        kind: "group",
        external: false,
        title: "Collection",
        children: [page("current", "Navigation label")],
      },
      {
        id: "external",
        kind: "link",
        external: true,
        title: 'Reference <site> "docs"',
        path: "https://example.com/docs?first=1&second=2",
      },
      page("next", "Next article"),
    ]);
    expect(html).toContain('<details class="navigation-group" open="">');
    expect(html).toContain('href="/en/current" aria-current="page"');
    expect(html).toContain('<span aria-current="page">Navigation label</span>');
    expect(html).toContain('class="previous-page" href="/en/previous"');
    expect(html).toContain('class="next-page" href="/en/next"');
    expect(html).toContain(
      'href="https://example.com/docs?first=1&amp;second=2" target="_blank" rel="noopener noreferrer"',
    );
    expect(html).not.toContain('Reference <site> "docs"');
    const adjacent = /<nav class="page-pagination"[\s\S]*?<\/nav>/.exec(
      html,
    )?.[0];
    expect(adjacent).toBeDefined();
    expect(adjacent).not.toContain("example.com");
  });

  it("keeps unlisted articles readable with a title breadcrumb and no invented neighbors", () => {
    for (const entries of [[], [page("different", "Another article")]]) {
      const html = render(entries);
      expect(html).toContain(
        '<span aria-current="page">Current article</span>',
      );
      expect(html).toContain("<h1>Current article</h1>");
      expect(html).toContain("<p>Visible body</p>");
      expect(html).not.toContain('class="page-pagination"');
    }
  });
});
