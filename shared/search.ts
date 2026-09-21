import { toText } from "hast-util-to-text";
import type { Nodes } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkDirective);

const htmlText = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize);

function readableText(node: Nodes): string {
  if (node.type === "html")
    return toText(htmlText.runSync(htmlText.parse(node.value)));
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node) return node.children.map(readableText).join(" ");
  if ("value" in node)
    return node.value.replace(
      /\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g,
      (_match, path: string, label?: string) => label ?? path,
    );
  return "";
}

/** Extract display text without Markdown delimiters, link URLs, or hidden HTML. */
export function markdownText(source: string): string {
  return readableText(parser.parse(source)).replace(/\s+/gu, " ").trim();
}

/** Keep original display text separately; FTS needs spaces between Han tokens. */
export function indexSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\p{Script=Han}/gu, (character) => ` ${character} `)
    .replace(/\s+/gu, " ")
    .trim();
}

/** No user-provided operators enter MATCH. Chinese runs become adjacent phrases. */
export function compileSearchQuery(query: string): string | null {
  if (query.length > 200) return null;
  const words = query.normalize("NFKC").match(/[\p{L}\p{N}\p{M}]+/gu);
  if (!words?.length) return null;
  return words.map((word) => `"${indexSearchText(word)}"`).join(" AND ");
}
