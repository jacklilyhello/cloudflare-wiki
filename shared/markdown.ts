import type { Root as HastRoot, Properties } from "hast";
import { toText } from "hast-util-to-text";
import type {
  Nodes as MdastNode,
  Parent as MdastParent,
  Root as MdastRoot,
} from "mdast";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  type Options as SanitizeOptions,
} from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";
import type { Language } from "./contracts";
import type { RenderedMarkdown, TocEntry } from "./reader";

export const MARKDOWN_LIMITS = {
  sourceBytes: 128_000,
  nodes: 12_000,
  nesting: 64,
  codeCharacters: 24_000,
  diagramCharacters: 8_000,
  diagrams: 8,
  mathCharacters: 2_000,
  mathExpressions: 80,
  tabs: 12,
} as const;

export class MarkdownLimitError extends Error {
  constructor() {
    super("This document exceeds the Markdown rendering limits.");
    this.name = "MarkdownLimitError";
  }
}

const headingPrefix = "user-content-wikih-";
const calloutKinds = new Set([
  "note",
  "tip",
  "important",
  "warning",
  "caution",
]);
const safeHtmlTags = [
  "a",
  "abbr",
  "aside",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "var",
];
// KaTeX's MathML-only output avoids CSP-breaking inline CSS and a font download.
const mathTags = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "mspace",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "mroot",
  "msqrt",
  "mtable",
  "mtr",
  "mtd",
  "mover",
  "munder",
  "munderover",
  "mpadded",
  "mstyle",
  "menclose",
  "mphantom",
  "mmultiscripts",
  "mprescripts",
  "none",
];
const mathAttributes = [
  "display",
  "mathVariant",
  "mathvariant",
  "mathColor",
  "mathcolor",
  "mathSize",
  "mathsize",
  "displayStyle",
  "displaystyle",
  "scriptLevel",
  "scriptlevel",
  "encoding",
  "stretchy",
  "fence",
  "separator",
  "accent",
  "accentunder",
  "largeop",
  "movablelimits",
  "lspace",
  "rspace",
  "minsize",
  "maxsize",
  "width",
  "height",
  "depth",
  "voffset",
  "columnalign",
  "rowalign",
  "columnspacing",
  "rowspacing",
  "columnlines",
  "rowlines",
  "columnspan",
  "rowspan",
  "linethickness",
  "notation",
];
const schema: SanitizeOptions = {
  tagNames: [...safeHtmlTags, ...mathTags],
  attributes: {
    "*": ["id", "title", "lang", ["dir", "ltr", "rtl", "auto"]],
    a: [
      "href",
      "ariaLabel",
      "ariaDescribedBy",
      "dataFootnoteRef",
      "dataFootnoteBackref",
      ["className", "heading-anchor", "data-footnote-backref"],
    ],
    aside: [
      [
        "className",
        "callout",
        ...[...calloutKinds].map((kind) => `callout-${kind}`),
      ],
    ],
    code: [["className", "hljs", /^language-[\w-]+$/]],
    details: ["open", ["className", "wiki-tab"]],
    h2: [["className", "sr-only"]],
    img: ["src", "alt", ["loading", "lazy"], ["decoding", "async"]],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
    li: [["className", "task-list-item"]],
    ol: ["start", ["className", "contains-task-list"]],
    p: [["className", "callout-title"]],
    pre: [["className", "mermaid-source"]],
    section: ["dataFootnotes", ["className", "footnotes", "wiki-tabs"]],
    span: [
      [
        "className",
        "katex",
        "katex-mathml",
        "katex-display",
        "katex-error",
        /^hljs-[\w-]+$/,
      ],
    ],
    td: [["align", "left", "center", "right"]],
    th: [["align", "left", "center", "right"]],
    ul: [["className", "contains-task-list"]],
    ...Object.fromEntries(mathTags.map((tag) => [tag, mathAttributes])),
  },
  protocols: { href: ["https", "http", "mailto"], src: ["https", "http"] },
  clobber: ["id", "name", "ariaDescribedBy", "ariaLabelledBy"],
  clobberPrefix: "user-content-",
  required: { input: { disabled: true, type: "checkbox" } },
  ancestors: {
    tbody: ["table"],
    td: ["table"],
    th: ["table"],
    thead: ["table"],
    tr: ["table"],
  },
  strip: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "template",
    "svg",
    "form",
  ],
};

function checkTree(tree: MdastRoot | HastRoot) {
  const pending: { node: { children?: unknown[] }; depth: number }[] = [
    { node: tree, depth: 0 },
  ];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (
      ++count > MARKDOWN_LIMITS.nodes ||
      current.depth > MARKDOWN_LIMITS.nesting
    )
      throw new MarkdownLimitError();
    for (const child of current.node.children ?? []) {
      pending.push({
        node: child as { children?: unknown[] },
        depth: current.depth + 1,
      });
    }
  }
}

// Bound pathological nesting before the Markdown and HTML parsers recurse.
// This is deliberately conservative for malformed HTML; Markdown has no reason
// to embed dozens of nested layout wrappers.
function checkSourceNesting(source: string) {
  for (const line of source.split("\n")) {
    let rest = line;
    let depth = 0;
    for (;;) {
      const match = /^ {0,3}>[ \t]?/.exec(rest);
      if (!match) break;
      if (++depth > MARKDOWN_LIMITS.nesting) throw new MarkdownLimitError();
      rest = rest.slice(match[0].length);
    }
  }
}

function checkRawHtmlNesting(tree: HastRoot) {
  const stack: string[] = [];
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  visit(tree, "raw", (node) => {
    for (const match of node.value.matchAll(
      /<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*|\s*\/?)>/gi,
    )) {
      const tag = match[2]?.toLowerCase() ?? "";
      if (match[1]) {
        const index = stack.lastIndexOf(tag);
        if (index >= 0) stack.splice(index);
      } else if (!voidTags.has(tag)) {
        stack.push(tag);
        if (stack.length > MARKDOWN_LIMITS.nesting)
          throw new MarkdownLimitError();
      }
    }
  });
}

function slug(text: string) {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 80) || "section"
  );
}

function hasUrlControls(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function wikiHref(target: string, language: Language): string | null {
  const [path = "", fragment, extra] = target.trim().split("#");
  if (
    extra !== undefined ||
    /[\s\\:%?]/u.test(path) ||
    hasUrlControls(path) ||
    path.startsWith("//")
  )
    return null;
  const normalized = path.replace(/^\//, "").replace(/\/$/, "");
  const segments = normalized.split("/");
  if (
    normalized &&
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !/^[\p{L}\p{N}_-]+$/u.test(segment),
    )
  )
    return null;
  if (!normalized && !fragment) return null;
  const url = normalized
    ? `/${language}/${segments.map(encodeURIComponent).join("/")}`
    : "";
  return `${url}${fragment ? `#${headingPrefix}${slug(fragment)}` : ""}`;
}

function textContent(node: MdastNode): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(textContent).join("");
  return "";
}

function markdownExtensions(language: Language) {
  return (tree: MdastRoot) => {
    checkTree(tree);
    let diagrams = 0;
    let expressions = 0;
    visit(tree, (node, index, parent) => {
      if (node.type === "code") {
        if (node.value.length > MARKDOWN_LIMITS.codeCharacters)
          throw new MarkdownLimitError();
        if (node.lang?.toLowerCase() === "mermaid") {
          if (
            ++diagrams > MARKDOWN_LIMITS.diagrams ||
            node.value.length > MARKDOWN_LIMITS.diagramCharacters
          )
            throw new MarkdownLimitError();
          node.lang = "mermaid";
        }
      }
      if (
        node.type === "math" ||
        node.type === "inlineMath" ||
        (node.type === "code" && node.lang === "math")
      ) {
        if (
          ++expressions > MARKDOWN_LIMITS.mathExpressions ||
          node.value.length > MARKDOWN_LIMITS.mathCharacters
        )
          throw new MarkdownLimitError();
      }
      if (node.type === "blockquote") {
        const paragraph = node.children[0];
        const first =
          paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
        const match =
          first?.type === "text"
            ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*\n|\s*$)/i.exec(
                first.value,
              )
            : null;
        if (match && first?.type === "text") {
          const kind = match[1]?.toLowerCase() ?? "note";
          first.value = first.value.slice(match[0].length);
          node.data = {
            hName: "aside",
            hProperties: { className: ["callout", `callout-${kind}`] },
          };
          node.children.unshift({
            type: "paragraph",
            data: { hProperties: { className: ["callout-title"] } },
            children: [
              {
                type: "text",
                value:
                  language === "zh"
                    ? ({
                        note: "说明",
                        tip: "提示",
                        important: "重要",
                        warning: "警告",
                        caution: "注意",
                      }[kind] ?? "说明")
                    : kind[0]?.toUpperCase() + kind.slice(1),
              },
            ],
          });
        }
      }
      if (node.type === "containerDirective" && node.name === "tabs") {
        const groups: MdastNode[][] = [];
        const introduction: MdastNode[] = [];
        for (const child of node.children) {
          if (child.type === "leafDirective" && child.name === "tab")
            groups.push([child]);
          else if (groups.length) groups.at(-1)?.push(child);
          else introduction.push(child);
        }
        if (groups.length > MARKDOWN_LIMITS.tabs)
          throw new MarkdownLimitError();
        if (groups.length) {
          node.data = {
            hName: "section",
            hProperties: { className: ["wiki-tabs"] },
          };
          node.children = [
            ...introduction,
            ...groups.map(([label, ...children], tabIndex) => ({
              type: "blockquote",
              data: {
                hName: "details",
                hProperties: { className: ["wiki-tab"], open: tabIndex === 0 },
              },
              children: [
                {
                  type: "paragraph",
                  data: { hName: "summary" },
                  children: [
                    {
                      type: "text",
                      value: label
                        ? textContent(label) || `Tab ${tabIndex + 1}`
                        : `Tab ${tabIndex + 1}`,
                    },
                  ],
                },
                ...(children as MdastParent["children"]),
              ],
            })),
          ] as typeof node.children;
        }
      }
      if (
        node.type !== "text" ||
        !parent ||
        index === undefined ||
        parent.type === "link" ||
        parent.type === "linkReference"
      )
        return;
      const pattern = /\[\[([^\]\n]+)\]\]/g;
      const replacements: MdastNode[] = [];
      let end = 0;
      for (const match of node.value.matchAll(pattern)) {
        const [target = "", ...labelParts] = (match[1] ?? "").split("|");
        const href = wikiHref(target, language);
        if (!href) continue;
        if (match.index > end)
          replacements.push({
            type: "text",
            value: node.value.slice(end, match.index),
          });
        replacements.push({
          type: "link",
          url: href,
          children: [
            { type: "text", value: labelParts.join("|").trim() || target },
          ],
        });
        end = match.index + match[0].length;
      }
      if (replacements.length) {
        if (end < node.value.length)
          replacements.push({ type: "text", value: node.value.slice(end) });
        (parent.children as MdastNode[]).splice(index, 1, ...replacements);
        return [SKIP, index + replacements.length];
      }
    });
    checkTree(tree);
  };
}

/** Shared by the public reader and the future Markdown preview. No browser or Node APIs. */
export async function renderMarkdown(
  markdown: string,
  language: Language,
): Promise<RenderedMarkdown> {
  if (
    markdown.length > MARKDOWN_LIMITS.sourceBytes ||
    new TextEncoder().encode(markdown).byteLength > MARKDOWN_LIMITS.sourceBytes
  )
    throw new MarkdownLimitError();
  checkSourceNesting(markdown);
  const toc: TocEntry[] = [];
  // Raw HTML cannot guess this marker: it is generated after the input is fixed and
  // checked absent from the source. It never reaches the serialized document.
  let marker = crypto.randomUUID();
  while (markdown.includes(marker)) marker = crypto.randomUUID();
  const origins = new Map<string, { tag: string; properties: Properties }>();
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkDirective)
    .use(() => markdownExtensions(language))
    .use(remarkRehype, {
      allowDangerousHtml: true,
      clobberPrefix: "",
      footnoteLabel: language === "zh" ? "注释" : "Footnotes",
    })
    .use(() => (tree: HastRoot) => {
      checkTree(tree);
      checkRawHtmlNesting(tree);
      visit(tree, "element", (node) => {
        const token = `${marker}-${origins.size}`;
        origins.set(token, {
          tag: node.tagName,
          properties: { ...node.properties },
        });
        node.properties.dataWikiOrigin = token;
      });
    })
    .use(rehypeRaw, { tagfilter: true })
    .use(() => (tree: HastRoot) => {
      checkTree(tree);
      visit(tree, "element", (node) => {
        const token = node.properties.dataWikiOrigin;
        const origin =
          typeof token === "string" ? origins.get(token) : undefined;
        if (origin?.tag === node.tagName)
          node.properties = { ...origin.properties };
        else {
          for (const key of Object.keys(node.properties)) {
            if (
              /^(?:data|aria|on)/i.test(key) ||
              ["className", "id", "name", "style"].includes(key)
            )
              delete node.properties[key];
          }
        }
      });
      // Only inspect enhancement classes after every raw node has lost author-supplied classes.
      visit(tree, "element", (node) => {
        if (node.tagName === "pre") {
          const code = node.children[0];
          if (
            code?.type === "element" &&
            code.tagName === "code" &&
            Array.isArray(code.properties.className) &&
            code.properties.className.includes("language-mermaid")
          ) {
            node.properties.className = ["mermaid-source"];
            code.properties = {};
          }
        }
        if (node.tagName === "img") {
          node.properties.loading = "lazy";
          node.properties.decoding = "async";
        }
        for (const property of ["href", "src"] as const) {
          const value = node.properties[property];
          // Protocol-relative URLs, backslashes and controls are never valid wiki assets/links.
          if (
            typeof value === "string" &&
            (/^\s*\/\//.test(value) ||
              value.includes("\\") ||
              hasUrlControls(value))
          )
            delete node.properties[property];
        }
      });
    })
    .use(rehypeHighlight, {
      detect: false,
      ignoreMissing: true,
      plainText: ["mermaid", "math"],
    })
    .use(rehypeKatex, {
      output: "mathml",
      trust: false,
      strict: "error",
      maxExpand: 200,
      maxSize: 10,
    })
    .use(() => (tree: HastRoot) => {
      checkTree(tree);
      const seen = new Set<string>();
      const fragmentIds = new Map<string, string>();
      visit(tree, "element", (node) => {
        if (typeof node.properties.id === "string")
          fragmentIds.set(
            node.properties.id,
            `user-content-${node.properties.id}`,
          );
        if (
          !/^h[1-6]$/.test(node.tagName) ||
          (Array.isArray(node.properties.className) &&
            node.properties.className.includes("sr-only"))
        )
          return;
        const text = toText(node);
        const base = slug(text);
        let id = base;
        let count = 1;
        while (seen.has(id)) id = `${base}-${++count}`;
        seen.add(id);
        node.properties.id = `wikih-${id}`;
        const fullId = `${headingPrefix}${id}`;
        fragmentIds.set(id, fullId);
        toc.push({ id: fullId, text, depth: Number(node.tagName.slice(1)) });
        node.children.push({
          type: "element",
          tagName: "a",
          properties: {
            className: ["heading-anchor"],
            href: `#${fullId}`,
            ariaLabel: `${language === "zh" ? "链接到" : "Link to"} ${text}`,
          },
          children: [{ type: "text", value: "#" }],
        });
      });
      visit(tree, "element", (node) => {
        const href = node.properties.href;
        if (typeof href === "string" && href.startsWith("#")) {
          const fragment = href.slice(1);
          let mapped = fragmentIds.get(fragment);
          if (!mapped) {
            try {
              // Markdown links encode Unicode, but heading IDs retain Unicode.
              // Decode once for lookup only; preserve unknown/malformed URLs.
              mapped = fragmentIds.get(decodeURIComponent(fragment));
            } catch {
              // A malformed fragment is inert and must not fail the document.
            }
          }
          if (mapped) node.properties.href = `#${mapped}`;
        }
      });
    })
    .use(rehypeSanitize, schema)
    .use(rehypeStringify);
  try {
    const result = await processor.process(markdown);
    return { html: String(result), toc };
  } catch (error) {
    // Parser stack exhaustion is an input limit, never a user-visible stack trace.
    if (error instanceof RangeError) throw new MarkdownLimitError();
    throw error;
  }
}
