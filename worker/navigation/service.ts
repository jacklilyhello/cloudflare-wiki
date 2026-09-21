import type { Language } from "../../shared/contracts";
import {
  NAVIGATION_LIMITS,
  type NavigationDocument,
  type NavigationInput,
  type NavigationMode,
  type NavigationNode,
  type NavigationTarget,
  normalizeNavigationUrl,
} from "../../shared/navigation";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";

type TreeRow = {
  language: Language;
  version: number;
  mode: NavigationMode;
  updated_at: string;
};
type NodeRow = {
  id: string;
  parent_id: string | null;
  position: number;
  kind: NavigationNode["kind"];
  label: string | null;
  translation_id: string | null;
  external_url: string | null;
};
type TargetRow = {
  id: string;
  language: Language;
  slug: string;
  draft_title: string;
  published_title: string | null;
  deleted_at: string | null;
};
type PublishedRow = TargetRow & { published_title: string };
type SqlValue = string | number | null;

export class NavigationError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 412,
    message: string,
  ) {
    super(message);
    this.name = "NavigationError";
  }
}
function invalid(message = "Invalid navigation tree."): never {
  throw new NavigationError(400, message);
}
function languageValue(value: unknown): Language {
  if (value !== "zh" && value !== "en") invalid("Invalid navigation language.");
  return value;
}
function idValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)
  )
    invalid("Invalid navigation identifier.");
  return value;
}
function nodeValue(row: NodeRow): NavigationNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    position: row.position,
    kind: row.kind,
    label: row.label,
    translationId: row.translation_id,
    externalUrl: row.external_url,
  };
}
function targetValue(row: TargetRow): NavigationTarget {
  return {
    id: row.id,
    language: row.language,
    path: row.slug,
    draftTitle: row.draft_title,
    publishedTitle: row.deleted_at ? null : row.published_title,
    deleted: row.deleted_at !== null,
  };
}
function validateNodes(input: unknown): NavigationNode[] {
  if (!Array.isArray(input) || input.length > NAVIGATION_LIMITS.nodes)
    invalid("Navigation supports at most 300 nodes.");
  const ids = new Map<string, NavigationNode>();
  const pages = new Set<string>();
  const children = new Map<string | null, NavigationNode[]>();
  const keys = [
    "id",
    "parentId",
    "position",
    "kind",
    "label",
    "translationId",
    "externalUrl",
  ];
  for (const candidate of input) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Object.keys(candidate).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(candidate, key))
    )
      invalid();
    const node: NavigationNode = { ...candidate, id: idValue(candidate.id) };
    if (
      ids.has(node.id) ||
      !["group", "page", "link"].includes(node.kind) ||
      !Number.isSafeInteger(node.position) ||
      node.position < 0
    )
      invalid();
    if (node.parentId !== null) node.parentId = idValue(node.parentId);
    if (node.label !== null) {
      if (
        typeof node.label !== "string" ||
        !node.label.trim() ||
        node.label.length > NAVIGATION_LIMITS.label
      )
        invalid("Invalid navigation label.");
      node.label = node.label.trim();
    }
    if (node.kind === "page") {
      node.translationId = idValue(node.translationId);
      if (node.externalUrl !== null || pages.has(node.translationId))
        invalid("A page may appear only once in each navigation tree.");
      pages.add(node.translationId);
    } else {
      if (node.translationId !== null || node.label === null) invalid();
      if (node.kind === "group") {
        if (node.externalUrl !== null) invalid();
      } else {
        node.externalUrl = normalizeNavigationUrl(node.externalUrl);
        if (!node.externalUrl) invalid("Invalid navigation link.");
      }
    }
    ids.set(node.id, node);
    const siblings = children.get(node.parentId) ?? [];
    if (siblings.some((sibling) => sibling.position === node.position))
      invalid("Sibling positions must be unique.");
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const node of ids.values()) {
    if (node.parentId !== null && ids.get(node.parentId)?.kind !== "group")
      invalid("Only an existing group may contain navigation nodes.");
    const seen = new Set<string>();
    let current: NavigationNode | undefined = node;
    while (current) {
      if (seen.has(current.id)) invalid("Navigation contains a cycle.");
      seen.add(current.id);
      if (seen.size > NAVIGATION_LIMITS.depth)
        invalid("Navigation supports at most eight levels.");
      current =
        current.parentId === null ? undefined : ids.get(current.parentId);
    }
  }
  const ordered: NavigationNode[] = [];
  function append(parent: string | null) {
    const siblings = (children.get(parent) ?? []).sort(
      (a, b) => a.position - b.position,
    );
    siblings.forEach((node, position) => {
      node.position = position;
      ordered.push(node);
      append(node.id);
    });
  }
  append(null);
  return ordered;
}

function folderLabel(segment: string, language: Language) {
  if (segment === "guide") return language === "zh" ? "使用指南" : "Guides";
  const text = segment.replace(/[-_]/g, " ");
  return language === "en"
    ? text.charAt(0).toUpperCase() + text.slice(1)
    : text;
}
function automaticNodes(
  rows: PublishedRow[],
  language: Language,
): NavigationNode[] | null {
  if (rows.length > NAVIGATION_LIMITS.nodes) return null;
  const folders = new Set<string>();
  for (const row of rows) {
    const segments = row.slug.split("/");
    for (let count = 1; count < segments.length; count++)
      folders.add(segments.slice(0, count).join("/"));
  }
  const result: NavigationNode[] = [];
  const groups = new Map<string, string>();
  const counts = new Map<string | null, number>();
  function append(
    kind: NavigationNode["kind"],
    parentId: string | null,
    label: string | null,
    translationId: string | null,
  ) {
    const node: NavigationNode = {
      id: crypto.randomUUID(),
      parentId,
      position: counts.get(parentId) ?? 0,
      kind,
      label,
      translationId,
      externalUrl: null,
    };
    counts.set(parentId, node.position + 1);
    result.push(node);
    return node.id;
  }
  for (const row of rows) {
    const segments = row.slug.split("/");
    let parent: string | null = null;
    for (let index = 0; index < segments.length; index++) {
      const path = segments.slice(0, index + 1).join("/");
      if (folders.has(path)) {
        let group = groups.get(path);
        if (!group) {
          group = append(
            "group",
            parent,
            folderLabel(segments[index] ?? "", language),
            null,
          );
          groups.set(path, group);
        }
        parent = group;
      }
    }
    append("page", parent, null, row.id);
    if (result.length > NAVIGATION_LIMITS.nodes) return null;
  }
  try {
    return validateNodes(result);
  } catch {
    return null;
  }
}
const targetColumns = `t.id,t.language,t.slug,d.title AS draft_title,r.title AS published_title,t.deleted_at`;
const targetJoins = `JOIN page_revisions d ON d.translation_id=t.id AND d.id=t.draft_revision_id
  LEFT JOIN page_revisions r ON r.translation_id=t.id AND r.id=t.published_revision_id`;

export class NavigationService {
  private readonly access: ContentWriteAccess;
  constructor(
    private readonly db: D1Database,
    access: ContentWriteAccess,
  ) {
    this.access = Object.freeze({ ...access });
    this.session();
  }
  private session() {
    try {
      return sessionGuard(this.access);
    } catch {
      throw new NavigationError(401, "Authentication required.");
    }
  }
  private statement(sql: string, values: SqlValue[] = []) {
    return this.db.prepare(sql).bind(...values);
  }
  private async requireAccess() {
    const guard = this.session();
    if (
      !(await this.statement(
        `SELECT 1 WHERE ${guard.sql}`,
        guard.values,
      ).first())
    )
      throw new NavigationError(401, "Authentication required.");
  }
  async get(language: Language): Promise<NavigationDocument> {
    languageValue(language);
    const guard = this.session();
    const results = await this.db.batch([
      this.statement(
        `SELECT * FROM navigation_trees WHERE language=? AND ${guard.sql}`,
        [language, ...guard.values],
      ),
      this.statement(
        `SELECT * FROM navigation_nodes WHERE language=? AND ${guard.sql}`,
        [language, ...guard.values],
      ),
      this.statement(
        `SELECT ${targetColumns} FROM page_translations t ${targetJoins} WHERE t.language=? AND t.deleted_at IS NULL AND r.id IS NOT NULL AND ${guard.sql} ORDER BY CASE WHEN t.slug='home' THEN 0 ELSE 1 END,t.slug LIMIT ?`,
        [language, ...guard.values, NAVIGATION_LIMITS.nodes + 1],
      ),
      this.statement(
        `SELECT ${targetColumns} FROM page_translations t ${targetJoins} WHERE t.language=? AND t.id IN (SELECT translation_id FROM navigation_nodes WHERE language=?) AND ${guard.sql}`,
        [language, language, ...guard.values],
      ),
    ]);
    const tree = results[0]?.results[0] as TreeRow | undefined;
    if (!tree) {
      await this.requireAccess();
      throw new NavigationError(404, "Navigation tree not found.");
    }
    const nodes = validateNodes(
      ((results[1]?.results as NodeRow[]) ?? []).map(nodeValue),
    );
    const published = (results[2]?.results as PublishedRow[]) ?? [];
    const automatic = automaticNodes(published, language);
    const targets = new Map<string, NavigationTarget>();
    for (const row of [
      ...(automatic ? published : []),
      ...((results[3]?.results as TargetRow[]) ?? []),
    ])
      targets.set(row.id, targetValue(row));
    return {
      language,
      version: tree.version,
      mode: tree.mode,
      nodes,
      updatedAt: tree.updated_at,
      automaticNodes: automatic,
      targets: [...targets.values()],
    };
  }
  async save(
    language: Language,
    input: NavigationInput,
  ): Promise<NavigationDocument> {
    languageValue(language);
    await this.requireAccess();
    if (
      !input ||
      typeof input !== "object" ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      !["automatic", "custom"].includes(input.mode)
    )
      invalid();
    const nodes = validateNodes(input.nodes);
    const current = await this.get(language);
    if (input.expectedVersion !== current.version)
      throw new NavigationError(
        412,
        "Navigation changed. Reload before retrying.",
      );
    const ids = nodes.flatMap((node) =>
      node.translationId ? [node.translationId] : [],
    );
    const session = this.session();
    const references = await this.statement(
      `SELECT ${targetColumns} FROM page_translations t ${targetJoins} WHERE t.id IN (SELECT value FROM json_each(?)) AND ${session.sql}`,
      [JSON.stringify(ids), ...session.values],
    ).all<TargetRow>();
    if (references.results.length !== ids.length) {
      await this.requireAccess();
      throw new NavigationError(404, "Referenced page not found.");
    }
    if (references.results.some((row) => row.language !== language))
      invalid("Navigation cannot reference a different language.");
    const guard = this.session();
    const predicate = `SELECT language FROM navigation_trees WHERE language=? AND version=? AND ${guard.sql}`;
    const values = [language, input.expectedVersion, ...guard.values];
    const now = new Date().toISOString();
    let results: D1Result<TreeRow>[];
    try {
      results = await this.db.batch<TreeRow>([
        this.statement(
          `DELETE FROM navigation_nodes WHERE language IN (${predicate})`,
          values,
        ),
        this.statement(
          `INSERT INTO navigation_nodes(language,id,parent_id,position,kind,label,translation_id,external_url)
          SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.parentId'),json_extract(value,'$.position'),json_extract(value,'$.kind'),json_extract(value,'$.label'),json_extract(value,'$.translationId'),json_extract(value,'$.externalUrl') FROM json_each(?) WHERE EXISTS(${predicate})`,
          [language, JSON.stringify(nodes), ...values],
        ),
        this.statement(
          `UPDATE navigation_trees SET mode=?,version=version+1,updated_at=? WHERE language IN (${predicate}) RETURNING *`,
          [input.mode, now, ...values],
        ),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/UNIQUE constraint|PRIMARY KEY constraint/i.test(message))
        throw new NavigationError(
          409,
          "Navigation conflicts with another change.",
        );
      if (/FOREIGN KEY constraint|CHECK constraint/i.test(message))
        invalid("Invalid navigation relationship.");
      throw new Error("Navigation storage operation failed.");
    }
    const updated = results[2]?.results[0];
    if (!updated) {
      await this.requireAccess();
      throw new NavigationError(
        412,
        "Navigation changed. Reload before retrying.",
      );
    }
    const automaticIds = new Set(
      current.automaticNodes?.flatMap((node) =>
        node.translationId ? [node.translationId] : [],
      ) ?? [],
    );
    const targets = new Map(
      current.targets
        .filter((target) => automaticIds.has(target.id))
        .map((target) => [target.id, target]),
    );
    for (const row of references.results) targets.set(row.id, targetValue(row));
    return {
      ...current,
      version: updated.version,
      mode: updated.mode,
      updatedAt: updated.updated_at,
      nodes,
      targets: [...targets.values()],
    };
  }
}
