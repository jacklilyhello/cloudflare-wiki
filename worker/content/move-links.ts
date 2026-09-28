import { AuthError } from "../../shared/auth";
import type { Language } from "../../shared/contracts";
import { renderMarkdown } from "../../shared/markdown";
import { publicPath } from "../../shared/paths";
import type { MoveLinkImpact } from "../../shared/relative-links";
import { type ContentWriteAccess, sessionGuard } from "../auth/access";
import { ContentError } from "./service";

export interface LinkMoveMember {
  id: string;
  version: number;
  fromPath: string;
  toPath: string;
}
type Target = { language: Language; path: string; id: string; slug: string };
export async function moveLinks(
  db: D1Database,
  access: ContentWriteAccess,
  language: Language,
  members: LinkMoveMember[],
) {
  const session = sessionGuard(access);
  const rows = await db
    .prepare(`SELECT t.id AS translation_id,r.markdown,b.path,r.id,t.draft_revision_id,t.published_revision_id
    FROM json_each(?) p JOIN page_translations t ON t.id=json_extract(p.value,'$.id') AND t.write_version=json_extract(p.value,'$.version') AND t.slug=json_extract(p.value,'$.fromPath')
    JOIN page_revisions r ON r.translation_id=t.id AND (r.id=t.draft_revision_id OR r.id=t.published_revision_id)
    LEFT JOIN revision_link_bases b ON b.revision_id=r.id
    WHERE t.language=? AND t.deleted_at IS NULL AND ${session.sql}`)
    .bind(JSON.stringify(members), language, ...session.values)
    .all<{
      translation_id: string;
      markdown: string;
      path: string | null;
      id: string;
      draft_revision_id: string;
      published_revision_id: string | null;
    }>();
  if (
    new Set(rows.results.map((row) => row.translation_id)).size !==
    members.length
  ) {
    const live = await db
      .prepare(`SELECT 1 AS live WHERE ${session.sql}`)
      .bind(...session.values)
      .first();
    if (!live) throw new AuthError(401, "Authentication required.");
    throw new ContentError(412, "Page changed. Refresh the move preview.");
  }
  const pending: {
    member: string;
    revision: "draft" | "published";
    source: string;
    resolved: string;
    language?: string;
    path: string;
    url: URL;
  }[] = [];
  for (const row of rows.results) {
    const member = members.find((member) => member.id === row.translation_id);
    if (!row.path)
      throw new ContentError(
        409,
        `Missing link context for ${member?.fromPath}. Move blocked; repair this revision's context first.`,
      );
    const links: { source: string; resolved: string }[] = [];
    await renderMarkdown(row.markdown, language, row.path, (source, resolved) =>
      links.push({ source, resolved }),
    );
    if (links.length > 256)
      throw new ContentError(
        409,
        `More than 256 relative links in ${member?.fromPath}. Use absolute site paths before moving.`,
      );
    for (const link of links) {
      const url = new URL(link.resolved, "https://wiki.invalid");
      const match = /^\/(zh|en)\/(.+)$/.exec(url.pathname);
      let path = "";
      try {
        path = decodeURIComponent(match?.[2] ?? "");
      } catch {
        /* Original malformed address remains missing. */
      }
      for (const revision of ["draft", "published"] as const) {
        if (
          row.id ===
          (revision === "draft"
            ? row.draft_revision_id
            : row.published_revision_id)
        )
          pending.push({
            ...link,
            url,
            language: match?.[1],
            path,
            revision,
            member: row.translation_id,
          });
      }
    }
  }
  const requests = [
    ...new Map(
      pending
        .filter((link) => link.language)
        .map((link) => [
          `${link.language}/${link.path}`,
          { language: link.language, path: link.path },
        ]),
    ).values(),
  ];
  if (requests.length > 1024)
    throw new ContentError(
      409,
      "More than 1024 distinct relative targets. Move a smaller directory or use absolute site paths.",
    );
  const targets = new Map<string, Target>();
  for (let offset = 0; offset < requests.length; offset += 256) {
    const found = await db
      .prepare(`SELECT r.language,r.path,t.id,t.slug FROM json_each(?) q
      JOIN page_routes r ON r.language=json_extract(q.value,'$.language') AND r.path=json_extract(q.value,'$.path')
      JOIN page_translations t ON t.id=r.translation_id WHERE t.deleted_at IS NULL AND ${session.sql}`)
      .bind(
        JSON.stringify(requests.slice(offset, offset + 256)),
        ...session.values,
      )
      .all<Target>();
    for (const target of found.results)
      targets.set(`${target.language}/${target.path}`, target);
  }
  const result = new Map<string, MoveLinkImpact[]>(
    members.map((member) => [member.id, []]),
  );
  for (const link of pending) {
    const target = targets.get(`${link.language}/${link.path}`);
    const moved = target && members.find((member) => member.id === target.id);
    const suffix = link.url.search + link.url.hash;
    const before = target
      ? publicPath(target.language, target.slug) + suffix
      : link.resolved;
    const after = moved ? publicPath(language, moved.toPath) + suffix : before;
    result.get(link.member)?.push({
      source: link.source,
      before,
      after,
      revision: link.revision,
      target: target ? "page" : link.language ? "missing" : "resource",
    });
  }
  return result;
}
