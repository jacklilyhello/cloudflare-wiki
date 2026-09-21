import DOMPurify from "dompurify";
import { canEnhanceDiagram, DIAGRAM_LIMITS } from "../../shared/diagram-policy";

let diagramId = 0;

// Never attach renderer-created SVG to the article DOM. SVG images cannot run
// scripts, navigate the parent, or access its document. Keep the textual source
// available for errors, unsupported syntax, printing, and assistive technology.
export async function enhanceDiagrams(
  root: HTMLElement,
  language: "zh" | "en",
) {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre.mermaid-source")]
    .slice(0, DIAGRAM_LIMITS.diagrams)
    .map((block) => ({
      block,
      source: block.querySelector("code")?.textContent ?? "",
    }))
    .filter(({ source }) => canEnhanceDiagram(source));
  if (!blocks.length) return;
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    maxTextSize: DIAGRAM_LIMITS.sourceCharacters,
    maxEdges: 150,
    suppressErrorRendering: true,
    theme: "neutral",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: [
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "htmlLabels",
      "flowchart",
      "theme",
      "suppressErrorRendering",
    ],
  });
  for (const { block, source } of blocks) {
    if (!block.isConnected || block.dataset.diagramReady) continue;
    block.dataset.diagramReady = "true";
    try {
      const { svg } = await mermaid.render(
        `wiki-diagram-${++diagramId}`,
        source,
      );
      if (!block.isConnected) continue;
      if (svg.length > DIAGRAM_LIMITS.svgCharacters)
        throw new Error("Diagram output limit");
      const clean = sanitizeDiagram(svg);
      const image = document.createElement("img");
      image.className = "wiki-diagram";
      image.alt =
        language === "zh"
          ? "流程图；文本源代码见下方"
          : "Diagram; text source follows below";
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`;
      await image.decode();
      if (!block.isConnected) continue;
      const details = document.createElement("details");
      details.className = "diagram-source";
      const summary = document.createElement("summary");
      summary.textContent =
        language === "zh" ? "查看图表源代码" : "View diagram source";
      details.append(summary);
      block.before(image, details);
      details.append(block);
    } catch {
      // A syntax error is local to one diagram. Never expose parser errors or
      // remove the original document content.
      block.dataset.diagramReady = "error";
    }
  }
}

function hasExternalCssReference(value: string): boolean {
  if (/\\|@import|@font-face/i.test(value)) return true;
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const target = (match[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!/^#[a-zA-Z0-9_.:-]+$/.test(target)) return true;
  }
  return false;
}

function sanitizeDiagram(source: string): string {
  const fragment = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "foreignObject",
      "script",
      "a",
      "image",
      "feImage",
      "use",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
      "discard",
      "mpath",
    ],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = fragment.querySelector("svg");
  if (!svg) throw new Error("Diagram SVG is missing");
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if (
      element.localName === "style" &&
      hasExternalCssReference(element.textContent ?? "")
    )
      throw new Error("Diagram stylesheet references a resource");
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name === "xml:base" ||
        (attribute.localName === "href" &&
          !/^#[a-zA-Z0-9_.:-]+$/.test(attribute.value))
      )
        element.removeAttributeNode(attribute);
      else if (hasExternalCssReference(attribute.value))
        element.removeAttributeNode(attribute);
    }
  }
  return new XMLSerializer().serializeToString(svg);
}
