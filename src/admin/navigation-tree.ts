import {
  NAVIGATION_LIMITS,
  type NavigationNode,
} from "../../shared/navigation";

const MAX_DEPTH = NAVIGATION_LIMITS.depth;

export function siblings(nodes: NavigationNode[], parentId: string | null) {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.position - b.position);
}
export function descendants(nodes: NavigationNode[], id: string): Set<string> {
  const result = new Set<string>([id]);
  for (let pass = 0; pass < MAX_DEPTH; pass++) {
    for (const node of nodes)
      if (node.parentId && result.has(node.parentId)) result.add(node.id);
  }
  return result;
}
export function normalize(nodes: NavigationNode[]): NavigationNode[] {
  const result: NavigationNode[] = [];
  function visit(parentId: string | null) {
    for (const [position, node] of siblings(nodes, parentId).entries()) {
      result.push({ ...node, position });
      visit(node.id);
    }
  }
  visit(null);
  return result;
}
export function nodeDepth(nodes: NavigationNode[], node: NavigationNode) {
  let depth = 1;
  let parentId = node.parentId;
  const seen = new Set([node.id]);
  while (parentId) {
    if (seen.has(parentId)) return MAX_DEPTH + 1;
    seen.add(parentId);
    const parent = nodes.find((value) => value.id === parentId);
    if (!parent) return MAX_DEPTH + 1;
    parentId = parent.parentId;
    depth++;
  }
  return depth;
}
export function canMove(
  nodes: NavigationNode[],
  id: string,
  parentId: string | null,
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (
    !byId.has(id) ||
    (parentId !== null && byId.get(parentId)?.kind !== "group")
  )
    return false;
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  function depth(nodeId: string): number {
    const known = depths.get(nodeId);
    if (known !== undefined) return known;
    const node = byId.get(nodeId);
    if (!node || visiting.has(nodeId)) return MAX_DEPTH + 1;
    visiting.add(nodeId);
    const parent = nodeId === id ? parentId : node.parentId;
    const result = parent === null ? 1 : depth(parent) + 1;
    visiting.delete(nodeId);
    depths.set(nodeId, result);
    return result;
  }
  return nodes.every((node) => depth(node.id) <= MAX_DEPTH);
}
export function move(
  nodes: NavigationNode[],
  id: string,
  parentId: string | null,
  index: number,
) {
  if (!canMove(nodes, id, parentId)) return nodes;
  const source = nodes.find((node) => node.id === id);
  if (!source) return nodes;
  const rest = nodes.filter((node) => node.id !== id);
  const nextSiblings = siblings(rest, parentId);
  nextSiblings.splice(index, 0, { ...source, parentId });
  const positions = new Map(
    nextSiblings.map((node, position) => [node.id, position]),
  );
  return normalize(
    [...rest, { ...source, parentId }].map((node) =>
      node.parentId === parentId
        ? { ...node, position: positions.get(node.id) ?? node.position }
        : node,
    ),
  );
}

export function removeNode(
  nodes: NavigationNode[],
  id: string,
  promote: boolean,
) {
  const target = nodes.find((node) => node.id === id);
  if (!target) return nodes;
  if (promote) {
    const peers = siblings(nodes, target.parentId);
    const index = peers.findIndex((node) => node.id === id);
    peers.splice(
      index,
      1,
      ...siblings(nodes, id).map((node) => ({
        ...node,
        parentId: target.parentId,
      })),
    );
    const replacements = new Map(
      peers.map((node, position) => [node.id, { ...node, position }]),
    );
    return normalize(
      nodes
        .filter((node) => node.id !== id)
        .map((node) => replacements.get(node.id) ?? node),
    );
  }
  const branch = descendants(nodes, id);
  return normalize(nodes.filter((node) => !branch.has(node.id)));
}
