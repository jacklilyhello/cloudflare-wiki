import type { Language } from "./contracts";

export const NAVIGATION_LIMITS = {
  nodes: 300,
  depth: 8,
  label: 200,
  url: 2048,
} as const;
export type NavigationMode = "automatic" | "custom";
export interface NavigationNode {
  id: string;
  parentId: string | null;
  position: number;
  kind: "group" | "page" | "link";
  label: string | null;
  translationId: string | null;
  externalUrl: string | null;
}
export interface NavigationInput {
  expectedVersion: number;
  mode: NavigationMode;
  nodes: NavigationNode[];
}
export interface NavigationDocument {
  language: Language;
  version: number;
  mode: NavigationMode;
  nodes: NavigationNode[];
  updatedAt: string;
  automaticNodes: NavigationNode[] | null;
  targets: NavigationTarget[];
}
export interface NavigationTarget {
  id: string;
  language: Language;
  path: string;
  draftTitle: string;
  publishedTitle: string | null;
  deleted: boolean;
}

// Navigation links are opened by the visitor; the server never fetches them.
export function normalizeNavigationUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > NAVIGATION_LIMITS.url ||
    value !== value.trim() ||
    !/^https?:\/\//i.test(value) ||
    /\\|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.href.length > NAVIGATION_LIMITS.url
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
