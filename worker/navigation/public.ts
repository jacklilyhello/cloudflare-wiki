import type { Language } from "../../shared/contracts";
import {
  NAVIGATION_LIMITS,
  normalizeNavigationUrl,
} from "../../shared/navigation";
import { publicPath } from "../../shared/paths";
import type { NavigationEntry } from "../../shared/reader";

interface Row {
  mode: "automatic" | "custom";
  id: string | null;
  parent_id: string | null;
  position: number;
  kind: "group" | "page" | "link";
  label: string | null;
  external_url: string | null;
  slug: string | null;
  title: string | null;
}

// Null requests the existing automatic reader tree; a custom empty array is final.
// Publication ownership and current language are checked in one read snapshot.
export async function getPublicNavigation(
  db: D1Database,
  language: Language,
): Promise<NavigationEntry[] | null> {
  const rows = await db
    .prepare(`SELECT tree.mode,n.id,n.parent_id,n.position,n.kind,n.label,n.external_url,t.slug,r.title
    FROM navigation_trees tree
    LEFT JOIN navigation_nodes n ON n.language=tree.language AND tree.mode='custom'
    LEFT JOIN page_translations t ON t.id=n.translation_id AND t.language=tree.language AND t.deleted_at IS NULL
    LEFT JOIN page_revisions r ON r.id=t.published_revision_id AND r.translation_id=t.id
    WHERE tree.language=? ORDER BY n.position,n.id`)
    .bind(language)
    .all<Row>();
  if (!rows.results[0]) throw new Error("Navigation storage operation failed.");
  if (rows.results[0].mode === "automatic") return null;
  const children = new Map<string | null, Row[]>();
  for (const row of rows.results) {
    if (!row.id) continue;
    const siblings = children.get(row.parent_id) ?? [];
    siblings.push(row);
    children.set(row.parent_id, siblings);
  }
  const seen = new Set<string>();
  function project(parent: string | null, depth: number): NavigationEntry[] {
    if (depth > NAVIGATION_LIMITS.depth) return [];
    return (children.get(parent) ?? []).flatMap((row): NavigationEntry[] => {
      if (!row.id || seen.has(row.id) || seen.size >= NAVIGATION_LIMITS.nodes)
        return [];
      seen.add(row.id);
      if (row.kind === "group") {
        const nested = project(row.id, depth + 1);
        return nested.length && row.label
          ? [
              {
                id: row.id,
                kind: "group",
                external: false,
                title: row.label,
                children: nested,
              },
            ]
          : [];
      }
      if (row.kind === "page")
        return row.slug && row.title
          ? [
              {
                id: row.id,
                kind: "page",
                external: false,
                title: row.label ?? row.title,
                path: publicPath(language, row.slug),
              },
            ]
          : [];
      const url = normalizeNavigationUrl(row.external_url);
      return row.kind === "link" && url && row.label
        ? [
            {
              id: row.id,
              kind: "link",
              external: true,
              title: row.label,
              path: url,
            },
          ]
        : [];
    });
  }
  return project(null, 1);
}
