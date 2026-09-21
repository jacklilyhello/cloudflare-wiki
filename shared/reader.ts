import type { Language } from "./contracts";

export interface WikiPage {
  id: string;
  translationId: string;
  language: Language;
  path: string;
  title: string;
  description: string;
  markdown: string;
  tags: string[];
  updatedAt: string;
}

export interface TocEntry {
  id: string;
  text: string;
  depth: number;
}

export interface RenderedMarkdown {
  html: string;
  toc: TocEntry[];
}

export interface NavigationEntry {
  id: string;
  kind: "group" | "page" | "link";
  external: boolean;
  title: string;
  path?: string;
  children?: NavigationEntry[];
}

export interface SearchResult {
  title: string;
  description: string;
  path: string;
  excerpt: string;
  tags: string[];
}

export interface ReaderData {
  language: Language;
  page: WikiPage | null;
  rendered: RenderedMarkdown | null;
  navigation: NavigationEntry[];
  translations: Partial<Record<Language, string>>;
  mode: "article" | "search" | "not-found";
  searchQuery: string;
  searchResults: SearchResult[];
}
