import type { Language } from "./contracts";

/** Build the same canonical article URL for SSR links, redirects, and hydration. */
export function publicPath(language: Language, path: string): string {
  return `/${language}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
