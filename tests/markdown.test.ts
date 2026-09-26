import { describe, expect, it } from "vitest";
import {
  MARKDOWN_LIMITS,
  MarkdownLimitError,
  renderMarkdown,
} from "../shared/markdown";

describe("shared Markdown rendering in workerd", () => {
  it("renders CommonMark, GFM, accessible tasks, highlighted code and safe HTML", async () => {
    const { html } = await renderMarkdown(
      `# Guide

**Bold** and *emphasis* and ~~removed~~ with \`inline\` code.

> A quotation.

1. First
2. Second

- [x] Complete
- [ ] Pending

| Name | Value |
| :--- | ---: |
| A | B |

~~~typescript
const value = 42;
~~~

<details open><summary>More</summary><kbd>Enter</kbd> and <mark>highlight</mark>.</details>

![Diagram](/images/diagram.png)
`,
      "en",
    );
    for (const expected of [
      "<strong>Bold</strong>",
      "<em>emphasis</em>",
      "<del>removed</del>",
      "<code>inline</code>",
      "<blockquote>",
      "<ol>",
      '<input type="checkbox" checked disabled>',
      '<input type="checkbox" disabled>',
      "<table>",
      '<th align="right">Value</th>',
      'class="hljs language-typescript"',
      'class="hljs-keyword"',
      "<details open>",
      "<summary>More</summary>",
      "<kbd>Enter</kbd>",
      "<mark>highlight</mark>",
      'loading="lazy"',
      'decoding="async"',
    ])
      expect(html).toContain(expected);
  });

  it("creates deterministic collision-free heading IDs, anchors and TOC", async () => {
    const source =
      "# Hello\n\n## Hello\n\n## Hello-2\n\n### 中文 **指南**\n\n## !!!\n\n[Jump](#hello)";
    const first = await renderMarkdown(source, "zh");
    const second = await renderMarkdown(source, "zh");
    expect(first).toEqual(second);
    expect(first.toc).toEqual([
      { id: "user-content-wikih-hello", text: "Hello", depth: 1 },
      { id: "user-content-wikih-hello-2", text: "Hello", depth: 2 },
      { id: "user-content-wikih-hello-2-2", text: "Hello-2", depth: 2 },
      { id: "user-content-wikih-中文-指南", text: "中文 指南", depth: 3 },
      { id: "user-content-wikih-section", text: "!!!", depth: 2 },
    ]);
    expect(first.html).toContain('href="#user-content-wikih-hello">Jump</a>');
    expect(first.html).toContain('aria-label="链接到 Hello"');
    expect(first.html).not.toContain("data-wiki-origin");
  });

  it("keeps footnote IDs, ARIA labels and return links connected and out of TOC", async () => {
    const { html, toc } = await renderMarkdown(
      "Reference[^note] and again[^note].\n\n[^note]: A **footnote**.",
      "en",
    );
    expect(html).toContain('href="#user-content-fn-note"');
    expect(html).toContain('id="user-content-fn-note"');
    expect(html).toContain('href="#user-content-fnref-note"');
    expect(html).toContain('href="#user-content-fnref-note-2"');
    expect(html).toContain('aria-describedby="user-content-footnote-label"');
    expect(html).toContain('id="user-content-footnote-label"');
    expect(toc).toEqual([]);
  });

  it.each(["嵌套目标", "%E5%B5%8C%E5%A5%97%E7%9B%AE%E6%A0%87"])(
    "connects Unicode heading links after URL encoding: %s",
    async (fragment) => {
      const { html, toc } = await renderMarkdown(
        `[跳到嵌套目标](#${fragment})\n\n#### 嵌套目标`,
        "zh",
      );
      expect(html).toContain(
        'href="#user-content-wikih-嵌套目标">跳到嵌套目标</a>',
      );
      expect(html).toContain('id="user-content-wikih-嵌套目标"');
      expect(toc).toEqual([
        { id: "user-content-wikih-嵌套目标", text: "嵌套目标", depth: 4 },
      ]);
    },
  );

  it("preserves already prefixed fragments and malformed escapes without decoding twice", async () => {
    const { html } = await renderMarkdown(
      `[Ready](#user-content-wikih-target)
[Encoded ready](#user-content-wikih-%E7%9B%AE%E6%A0%87)
[Malformed](#%E0%A4%A)
[Double encoded](#%25E7%259B%25AE%25E6%25A0%2587)

## Target

## 目标`,
      "en",
    );
    expect(html).toContain('href="#user-content-wikih-target">Ready</a>');
    expect(html).toContain(
      'href="#user-content-wikih-%E7%9B%AE%E6%A0%87">Encoded ready</a>',
    );
    expect(html).toContain('href="#%E0%A4%25A">Malformed</a>');
    expect(html).toContain(
      'href="#%25E7%259B%25AE%25E6%25A0%2587">Double encoded</a>',
    );
    expect(html).not.toContain("user-content-user-content-");
  });

  it("resolves internal links in the current language without touching code or existing links", async () => {
    const { html } = await renderMarkdown(
      "[[guide/install|Install]] [[中文/指南|中文]] [[#Hello|Jump]] [[guide/install#Step 1|Step]]\n\n`[[guide/install]]` [existing [[label]]](https://example.com)",
      "zh",
    );
    expect(html).toContain('href="/zh/guide/install">Install</a>');
    expect(html).toContain(
      'href="/zh/%E4%B8%AD%E6%96%87/%E6%8C%87%E5%8D%97">中文</a>',
    );
    expect(html).toContain('href="#user-content-wikih-hello">Jump</a>');
    expect(html).toContain(
      'href="/zh/guide/install#user-content-wikih-step-1">Step</a>',
    );
    expect(html).toContain("<code>[[guide/install]]</code>");
    expect(html).toContain('href="https://example.com">existing [[label]]</a>');
  });

  it("leaves unsafe or ambiguous wiki links as harmless text", async () => {
    const { html } = await renderMarkdown(
      "[[javascript:alert(1)|Bad]] [[//evil.test/path|Bad]] [[../admin|Bad]] [[guide/%2e%2e/admin|Bad]] [[guide\\admin|Bad]]",
      "en",
    );
    expect(html).not.toContain("<a");
  });

  it("renders localized callouts and native, keyboard-accessible tabsets", async () => {
    const { html } = await renderMarkdown(
      "> [!WARNING]\n> Keep a **backup**.\n\n:::tabs\n::tab[Linux]\n\nUse Linux.\n\n::tab[Windows]\n\nUse Windows.\n:::",
      "zh",
    );
    expect(html).toContain('<aside class="callout callout-warning">');
    expect(html).toContain('<p class="callout-title">警告</p>');
    expect(html).toContain("<strong>backup</strong>");
    expect(html).toContain('<section class="wiki-tabs">');
    expect(html).toContain('<details class="wiki-tab" open>');
    expect(html).toContain("<summary>Linux</summary>");
    expect(html).toContain('<details class="wiki-tab">');
    expect(html).toContain("<summary>Windows</summary>");
  });

  it("renders constrained KaTeX MathML without inline styles or executable URLs", async () => {
    const { html } = await renderMarkdown(
      "Inline $E = mc^2$.\n\n$$\n\\frac{a}{b}\n$$\n\n$\\href{javascript:alert(1)}{x}$\n\n$\\htmlStyle{position:fixed}{x}$",
      "en",
    );
    expect(html).toContain('<span class="katex">');
    expect(html).toContain("<math>");
    expect(html).toContain("<mfrac>");
    expect(html).not.toMatch(/\sstyle=|<script|href="javascript:/i);
    expect(html).not.toContain('class="katex-html"');
  });

  it("keeps Mermaid source inert and prevents raw HTML from forging renderer controls", async () => {
    const { html } = await renderMarkdown(
      '```mermaid\ngraph TD\nA["<img src=x onerror=alert(1)>"] --> B\n```\n\n<pre class="mermaid-source" data-mermaid="evil"><code class="language-mermaid">forged graph</code></pre>\n\n<div class="wiki-tabs callout" data-wiki-origin="guessed"><span class="katex">forged</span></div>\n\n<code class="language-math">\\def\\a{\\a}\\a</code>',
      "en",
    );
    expect(html.match(/class="mermaid-source"/g)).toHaveLength(1);
    expect(html).toContain('A["&#x3C;img src=x onerror=alert(1)>"]');
    expect(html).toContain("<pre><code>forged graph</code></pre>");
    expect(html).not.toMatch(
      /data-mermaid|data-wiki-origin|class="wiki-tabs callout"|class="katex"|language-math/,
    );
    expect(html).not.toContain("<img");
  });

  it("sanitizes stored XSS, dangerous URLs, inline CSS and clobbering attributes", async () => {
    const { html } = await renderMarkdown(
      `<script>alert(1)</script>
<img src="javascript:alert(1)" onerror="alert(1)" style="position:fixed" id="location" name="__proto__">
<a href="jav&#x61;script:alert(1)" onclick="alert(1)" target="_blank">bad</a>
<a href="//evil.test">network path</a>
<a href="https://example.com">safe</a>
<iframe src="https://evil.test"></iframe>
<svg onload="alert(1)"><a href="javascript:alert(1)">svg</a></svg>
<form action="https://evil.test"><input type="password" name="password"></form>
<div id="reader-data" name="constructor" class="admin" data-action="delete">safe text</div>

[bad](data:text/html,evil) ![bad](data:image/svg+xml,evil)

<h2 id="__proto__">A heading</h2>`,
      "en",
    );
    expect(html).not.toMatch(
      /<(?:script|iframe|svg|form|object|embed)(?:\s|>)/i,
    );
    expect(html).not.toMatch(/\s(?:on\w+|style|name|target|data-action)=/i);
    expect(html).not.toMatch(/(?:href|src)="(?:javascript:|data:|\/\/)/i);
    expect(html).not.toMatch(/id="(?:location|reader-data|__proto__)"/);
    expect(html).not.toContain('class="admin"');
    expect(html).toContain('href="https://example.com">safe</a>');
    expect(html).toContain("safe text");
    expect(html).toContain('id="user-content-wikih-a-heading"');
  });

  it("handles malformed HTML, unknown languages and malformed math without failing the reader", async () => {
    const { html } = await renderMarkdown(
      "<div><b>Unclosed\n\n```not-a-real-language\nhello <world>\n```\n\n$\\notARealCommand{a}$",
      "en",
    );
    expect(html).toContain("Unclosed");
    expect(html).not.toMatch(/\sstyle=|<script/i);
  });

  it.each([
    [
      "source bytes",
      () => "中".repeat(Math.ceil(MARKDOWN_LIMITS.sourceBytes / 3) + 1),
    ],
    [
      "code size",
      () =>
        `\`\`\`text\n${"x".repeat(MARKDOWN_LIMITS.codeCharacters + 1)}\n\`\`\``,
    ],
    [
      "diagram size",
      () =>
        `\`\`\`mermaid\n${"x".repeat(MARKDOWN_LIMITS.diagramCharacters + 1)}\n\`\`\``,
    ],
    [
      "diagram count",
      () =>
        "```mermaid\ngraph TD; A-->B\n```\n\n".repeat(
          MARKDOWN_LIMITS.diagrams + 1,
        ),
    ],
    ["math size", () => `$${"x".repeat(MARKDOWN_LIMITS.mathCharacters + 1)}$`],
    ["math count", () => "$x$ ".repeat(MARKDOWN_LIMITS.mathExpressions + 1)],
    [
      "tabs",
      () =>
        `:::tabs\n${"::tab[Test]\n\nbody\n\n".repeat(MARKDOWN_LIMITS.tabs + 1)}:::`,
    ],
    ["nesting", () => `${"> ".repeat(MARKDOWN_LIMITS.nesting + 1)}deep`],
    [
      "raw HTML nesting",
      () =>
        `${"<div>".repeat(MARKDOWN_LIMITS.nesting + 1)}deep${"</div>".repeat(MARKDOWN_LIMITS.nesting + 1)}`,
    ],
    ["nodes", () => "**x** ".repeat(MARKDOWN_LIMITS.nodes / 2)],
  ])("rejects documents exceeding the %s limit", async (_name, source) => {
    await expect(renderMarkdown(source(), "en")).rejects.toBeInstanceOf(
      MarkdownLimitError,
    );
  });
});
