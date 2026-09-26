import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../shared/markdown";
import { tabFragmentId, tabSelectionForKey } from "../src/reader/tabs";

describe("horizontal tab keyboard selection", () => {
  it("cycles through the current group and supports both boundary shortcuts", () => {
    expect(tabSelectionForKey("ArrowRight", 1, 3)).toBe(2);
    expect(tabSelectionForKey("ArrowRight", 2, 3)).toBe(0);
    expect(tabSelectionForKey("ArrowLeft", 1, 3)).toBe(0);
    expect(tabSelectionForKey("ArrowLeft", 0, 3)).toBe(2);
    expect(tabSelectionForKey("Home", 2, 3)).toBe(0);
    expect(tabSelectionForKey("End", 0, 3)).toBe(2);
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"])
      expect(tabSelectionForKey(key, 0, 1)).toBe(0);
  });
  it("leaves vertical scrolling, tab order and native button activation intact", () => {
    for (const key of [
      "ArrowUp",
      "ArrowDown",
      "Tab",
      "Enter",
      " ",
      "Escape",
      "Delete",
    ])
      expect(tabSelectionForKey(key, 1, 3)).toBeNull();
  });
  it("does not calculate a selection for an invalid or empty group", () => {
    for (const [index, count] of [
      [0, 0],
      [-1, 3],
      [3, 3],
      [0.5, 3],
      [0, NaN],
      [0, 2.5],
    ] as const)
      expect(tabSelectionForKey("ArrowRight", index, count)).toBeNull();
  });
});

describe("tabset fragment navigation", () => {
  const location = "https://example.com/zh/guide?view=1";
  it.each([
    ["#user-content-wikih-安装", "user-content-wikih-安装"],
    ["#user-content-wikih-%E5%AE%89%E8%A3%85", "user-content-wikih-安装"],
    ["/zh/guide?view=1#part", "part"],
    ["https://example.com/zh/guide?view=1#part", "part"],
  ])("recognizes only matching-document targets: %s", (href, id) => {
    expect(tabFragmentId(href, location)).toBe(id);
  });
  it.each([
    "",
    "#",
    "#%E0%A4%A",
    "/zh/other#part",
    "?view=2#part",
    "/zh/guide#part",
    "https://other.invalid/zh/guide?view=1#part",
    "javascript:alert(1)",
    "mailto:user@example.com#part",
  ])("does not capture unrelated or malformed navigation: %s", (href) => {
    expect(tabFragmentId(href, location)).toBeNull();
  });
  it("keeps preview fragments local without intercepting article links", () => {
    const editor = "https://example.com/admin/pages/id/edit";
    expect(tabFragmentId("#user-content-wikih-安装", editor, true)).toBe(
      "user-content-wikih-安装",
    );
    expect(tabFragmentId("/admin/pages/id/edit#part", editor, true)).toBeNull();
    expect(
      tabFragmentId(
        "https://example.com/admin/pages/id/edit#part",
        editor,
        true,
      ),
    ).toBeNull();
    expect(tabFragmentId("/zh/guide#part", editor, true)).toBeNull();
  });
});

describe("trusted tabset disclosure fallback", () => {
  it("keeps nested groups, introductory content and heading anchors in safe fallback HTML", async () => {
    const { html, toc } = await renderMarkdown(
      `::::tabs
Introduction stays outside the panels.
::tab[Outer first]
First body.
::tab[Outer second]
:::tabs
::tab[Inner first]
Inner body.
::tab[Inner second]
## Nested destination

[Same section](#nested-destination)
:::
::::`,
      "en",
    );
    expect(html.match(/<section class="wiki-tabs">/g)).toHaveLength(2);
    expect(html.match(/<details class="wiki-tab"/g)).toHaveLength(4);
    expect(html.match(/<details class="wiki-tab" open>/g)).toHaveLength(2);
    expect(html).toContain(
      '<section class="wiki-tabs"><p>Introduction stays outside the panels.</p>',
    );
    expect(html).toContain(
      '<summary>Outer second</summary>\n<section class="wiki-tabs">',
    );
    expect(html).toContain('href="#user-content-wikih-nested-destination"');
    expect(toc).toEqual([
      {
        id: "user-content-wikih-nested-destination",
        text: "Nested destination",
        depth: 2,
      },
    ]);
    expect(html).not.toMatch(/role="tab|aria-selected|wiki-tabs-enhanced/);
  });
  it("does not let author HTML forge section/details enhancement classes or controls", async () => {
    const { html } = await renderMarkdown(
      `<section class="wiki-tabs wiki-tabs-enhanced" role="tablist" data-tab-label="forged">
<details class="wiki-tab" open><summary aria-controls="outside">Raw disclosure</summary><p>Safe raw body.</p></details>
</section>

:::tabs
::tab[Trusted]
Trusted body.
:::`,
      "en",
    );
    expect(html.match(/<section class="wiki-tabs">/g)).toHaveLength(1);
    expect(html.match(/<details class="wiki-tab"/g)).toHaveLength(1);
    expect(html).toContain(
      "<details open><summary>Raw disclosure</summary><p>Safe raw body.</p></details>",
    );
    expect(html).not.toMatch(
      /wiki-tabs-enhanced|role=|data-tab-label|aria-controls/,
    );
  });
  it("escapes labels and retains code and image nodes as ordinary sanitized content", async () => {
    const { html } = await renderMarkdown(
      ":::tabs\n::tab[<img src=x onerror=alert(1)>]\n\n```js\nconst safe = true;\n```\n\n![Screenshot](/files/example/image)\n:::",
      "en",
    );
    expect(html).toContain('<details class="wiki-tab" open>');
    expect(html).toContain(
      "<summary>&#x3C;img src=x onerror=alert(1)></summary>",
    );
    expect(html).not.toMatch(/<[^>]+\sonerror=/);
    expect(html).toContain('class="hljs language-js"');
    expect(html).toContain('src="/files/example/image"');
    expect(html).not.toMatch(/<button|<script|style=/);
  });
});
