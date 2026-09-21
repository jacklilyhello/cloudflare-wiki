// Keep browser enhancement bounded independently of the Markdown parser.
// Unsupported syntax always remains available as the original code block.
export const DIAGRAM_LIMITS = {
  sourceCharacters: 8_000,
  diagrams: 8,
  statements: 200,
  svgCharacters: 240_000,
} as const;

export function canEnhanceDiagram(source: string): boolean {
  if (!source.trim() || source.length > DIAGRAM_LIMITS.sourceCharacters)
    return false;
  if (source.split(/[;\n&]/u).length > DIAGRAM_LIMITS.statements) return false;
  // No frontmatter, init directives, property objects, author CSS, navigation,
  // image/icon assets or resource URLs. Forbid property objects as a whole:
  // Mermaid parses their YAML keys, including quoted/escaped asset key names.
  return !/%%\s*\{|^\s*---|@\s*\{|(?:^|[;\n])\s*(?:style|classDef|linkStyle)\b|\bclick\b|(?:https?|javascript|data):|\/\/|url\s*\(|@import|\b(?:img|image|icon)["']?\s*:|<\s*(?:img|image|svg|foreignObject)\b/im.test(
    source,
  );
}
