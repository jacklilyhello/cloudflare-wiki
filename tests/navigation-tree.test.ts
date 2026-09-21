import { describe, expect, it } from "vitest";
import type { NavigationNode } from "../shared/navigation";
import {
  canMove,
  move,
  removeNode,
  siblings,
} from "../src/admin/navigation-tree";

function group(
  id: string,
  parentId: string | null,
  position: number,
): NavigationNode {
  return {
    id,
    parentId,
    position,
    kind: "group",
    label: id,
    translationId: null,
    externalUrl: null,
  };
}

function page(
  id: string,
  parentId: string | null,
  position: number,
): NavigationNode {
  return {
    ...group(id, parentId, position),
    kind: "page",
    label: null,
    translationId: `translation-${id}`,
  };
}

function tree() {
  return [
    page("before", null, 0),
    group("folder", null, 1),
    page("first", "folder", 0),
    group("nested", "folder", 1),
    page("nested-page", "nested", 0),
    page("after", null, 2),
  ];
}

describe("visual navigation tree operations", () => {
  it("reorders a whole branch without changing its targets or the input tree", () => {
    const original = tree();
    const snapshot = structuredClone(original);
    const result = move(original, "folder", null, 0);
    expect(siblings(result, null).map((node) => node.id)).toEqual([
      "folder",
      "before",
      "after",
    ]);
    expect(siblings(result, null).map((node) => node.position)).toEqual([
      0, 1, 2,
    ]);
    expect(result.filter((node) => node.parentId !== null)).toEqual(
      original.filter((node) => node.parentId !== null),
    );
    expect(original).toEqual(snapshot);
  });

  it("indents and outdents a page while closing gaps in both sibling lists", () => {
    const indented = move(tree(), "after", "folder", 1);
    expect(siblings(indented, "folder").map((node) => node.id)).toEqual([
      "first",
      "after",
      "nested",
    ]);
    const result = move(indented, "first", null, 1);
    expect(siblings(result, null).map((node) => node.id)).toEqual([
      "before",
      "first",
      "folder",
    ]);
    expect(siblings(result, "folder").map((node) => node.position)).toEqual([
      0, 1,
    ]);
    expect(result.find((node) => node.id === "first")).toMatchObject({
      parentId: null,
      translationId: "translation-first",
    });
  });

  it("rejects cycles, missing nodes and a page as a parent without removing data", () => {
    const original = tree();
    for (const [id, parent] of [
      ["folder", "folder"],
      ["folder", "nested"],
      ["folder", "first"],
      ["folder", "missing"],
      ["missing", "folder"],
    ] as const) {
      expect(canMove(original, id, parent)).toBe(false);
      expect(move(original, id, parent, 0)).toBe(original);
    }
  });

  it("checks the deepest descendant when moving a subtree to the eight-level boundary", () => {
    const nodes: NavigationNode[] = Array.from({ length: 6 }, (_, index) =>
      group(`level-${index + 1}`, index ? `level-${index}` : null, 0),
    );
    nodes.push(group("branch", null, 1), page("leaf", "branch", 0));
    expect(canMove(nodes, "branch", "level-6")).toBe(true);
    const result = move(nodes, "branch", "level-6", 0);
    expect(result.find((node) => node.id === "leaf")?.parentId).toBe("branch");
    nodes.push(group("level-7", "level-6", 0));
    expect(canMove(nodes, "branch", "level-7")).toBe(false);
    expect(move(nodes, "branch", "level-7", 0)).toBe(nodes);
  });

  it("removes only the selected group and promotes its children at the same position", () => {
    const original = tree();
    const result = removeNode(original, "folder", true);
    expect(siblings(result, null).map((node) => node.id)).toEqual([
      "before",
      "first",
      "nested",
      "after",
    ]);
    expect(result.find((node) => node.id === "nested-page")).toEqual(
      original.find((node) => node.id === "nested-page"),
    );
    expect(result.map((node) => node.translationId).filter(Boolean)).toEqual(
      original.map((node) => node.translationId).filter(Boolean),
    );
    expect(original).toHaveLength(6);
  });

  it("removes a selected subtree without touching adjacent entries", () => {
    expect(removeNode(tree(), "folder", false)).toEqual([
      page("before", null, 0),
      page("after", null, 1),
    ]);
    expect(removeNode(tree(), "first", true).map((node) => node.id)).toEqual([
      "before",
      "folder",
      "nested",
      "nested-page",
      "after",
    ]);
  });
});
