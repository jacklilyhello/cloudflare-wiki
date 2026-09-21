import { describe, expect, it } from "vitest";
import { canEnhanceDiagram, DIAGRAM_LIMITS } from "../shared/diagram-policy";

describe("Mermaid browser enhancement source policy", () => {
  it.each([
    "flowchart LR\nA[Prepare] --> B[Configure]\nB --> C[Verify]",
    "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Ready",
    "stateDiagram-v2\n[*] --> Ready\nReady --> [*]",
  ])("accepts a bounded self-contained diagram: %s", (source) => {
    expect(canEnhanceDiagram(source)).toBe(true);
  });

  it.each([
    'flowchart LR\nA@{ img: "/health", label: "x" }',
    'flowchart LR\nA@{ "im\\u0067": "/api/private", label: "x" }',
    'flowchart LR\nA@{ icon: "external:logo", label: "x" }',
    'flowchart LR\nA["<img src=/health>"]',
    'flowchart LR\nA["//example.com/resource"]',
    'flowchart LR\nA["https://example.com/resource"]',
    'flowchart LR\nclick A "/admin"',
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA-->B',
    "---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B",
    "flowchart LR\nA-->B\nclassDef remote fill:url(/health)",
    "flowchart LR\nA-->B;style A fill:u\\72l(/health)",
    "flowchart LR\nA-->B\nlinkStyle 0 stroke:red",
    "flowchart LR\nA-->B\n@import '/health'",
  ])("retains resource/configuration syntax as source only: %s", (source) => {
    expect(canEnhanceDiagram(source)).toBe(false);
  });

  it("rejects empty and oversized or excessively dense diagrams before importing Mermaid", () => {
    expect(canEnhanceDiagram(" ")).toBe(false);
    expect(
      canEnhanceDiagram("x".repeat(DIAGRAM_LIMITS.sourceCharacters + 1)),
    ).toBe(false);
    expect(
      canEnhanceDiagram(
        `flowchart LR\n${"A;".repeat(DIAGRAM_LIMITS.statements)}`,
      ),
    ).toBe(false);
  });
});
