import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { resolveRelativeLink } from "../shared/relative-links";
import { sha256 } from "../worker/auth/crypto";
import { fixtureSessionToken } from "./content-fixture";
import { renderMarkdown } from "../shared/markdown";
import { PageDirectoryService } from "../worker/content/directories";
import { getNavigation, getPage, searchPages } from "../worker/content/public";
import type { ContentService } from "../worker/content/service";
import { contentFixture } from "./content-fixture";

let content: ContentService;
let directories: PageDirectoryService;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const fixture = await contentFixture(env.DB);
  content = fixture.service;
  directories = new PageDirectoryService(env.DB, fixture.access);
});
const body = {
  title: "Link acceptance",
  description: "Link fixtures",
  tags: [],
  markdown:
    '## Section\n\n[sibling](./target?mode=1#section) [up](../outside) [encoded](./%E4%B8%AD%E6%96%87) [missing](./absent) [self](#section) [query](?mode=2) [external](https://example.com/a) [file](../../files/example/download)\n\n`[inline](./leave)`\n\n```md\n[code](../leave)\n```\n\nPlain ./unchanged\n\n[reference][ref]\n\n[ref]: ./target "Label"\n\n<a href="./target">HTML link</a>\n\n![image](../../files/example/image)',
};
async function page(path: string, markdown = body.markdown) {
  const draft = await content.createTranslation({
    ...body,
    markdown,
    path,
    language: "en",
  });
  return content.publish(draft.id, draft.version, draft.draftRevisionId ?? "");
}
it("preserves published and distinct draft links across single move, save and history restore", async () => {
  let source = await page("source/article");
  const target = await page("source/target", "Target");
  await page("source/中文", "Encoded target");
  await page("outside", "Outside target");
  const oldPublished = await content.getRevision(
    source.id,
    source.publishedRevisionId ?? "",
  );
  source = await content.saveDraft(source.id, source.version, {
    ...body,
    markdown: `${body.markdown}\n\nDraft only`,
  });
  const before = await content.getDetail(source.id);
  const preview = await content.previewMove(
    source.id,
    source.version,
    "destination/article",
  );
  expect(preview.links).toContainEqual(
    expect.objectContaining({
      source: "./target?mode=1#section",
      before: "/en/source/target?mode=1#section",
      after: "/en/source/target?mode=1#section",
      revision: "published",
      target: "page",
    }),
  );
  expect(preview.links).toContainEqual(
    expect.objectContaining({
      source: "./absent",
      target: "missing",
      revision: "draft",
    }),
  );
  expect(preview.links.some((link) => link.source.includes("leave"))).toBe(
    false,
  );
  source = await content.move(source.id, source.version, "destination/article");
  expect(await content.getRevision(source.id, oldPublished.id)).toEqual(
    oldPublished,
  );
  const after = await content.getDetail(source.id);
  expect(after.draft).toEqual(before.draft);
  expect(after.published).toEqual(before.published);
  const publicPage = await getPage(env.DB, "en", "destination/article");
  expect(publicPage?.linkBasePath).toBe("source/article");
  const html = (
    await renderMarkdown(
      publicPage?.markdown ?? "",
      "en",
      publicPage?.linkBasePath,
    )
  ).html;
  expect(html).toContain('href="/en/source/target?mode=1#section"');
  expect(html).toContain('href="/en/source/%E4%B8%AD%E6%96%87"');
  expect(html).toContain('href="/files/example/download"');
  expect(html).toContain('href="?mode=2"');
  expect(html).toContain('href="#user-content-wikih-section"');
  expect(html).toContain('href="https://example.com/a"');
  expect(html).toContain("Plain ./unchanged");
  const redirect = await exports.default.fetch(
    "https://example.com/en/source/article?mode=1",
    { redirect: "manual" },
  );
  expect(redirect.status).toBe(301);
  expect(redirect.headers.get("location")).toBe(
    "/en/destination/article?mode=1",
  );
  source = await content.saveDraft(source.id, source.version, {
    ...body,
    markdown: `${body.markdown}\nEdited`,
  });
  expect((await content.getDetail(source.id)).draft.linkBasePath).toBe(
    "source/article",
  );
  source = await content.restoreRevision(
    source.id,
    source.version,
    oldPublished.id,
  );
  expect((await content.getDetail(source.id)).draft.linkBasePath).toBe(
    "source/article",
  );
  await content.move(target.id, target.version, "elsewhere/target");
  expect((await getPage(env.DB, "en", "source/target"))?.path).toBe(
    "elsewhere/target",
  );
});

it("previews directory targets and preserves landing pages, bilingual identities, search, navigation and all history", async () => {
  const landing = await page("source", "[child](./source/child)");
  const child = await page(
    "source/child",
    "[parent](../source) [sibling](./target)",
  );
  await page("source/target", "Target");
  const outside = await page("outside/ref", "[incoming](../source/child)");
  const zh = await content.createTranslation({
    ...body,
    language: "zh",
    path: "source/child",
    pageId: child.pageId,
  });
  const revisions = await env.DB.prepare(
    "SELECT * FROM page_revisions ORDER BY id",
  ).all();
  const preview = await directories.preview("en", {
    fromPath: "source",
    toPath: "new/tree",
  });
  expect(
    preview.members.find((member) => member.id === child.id)?.links,
  ).toContainEqual(
    expect.objectContaining({
      source: "./target",
      before: "/en/source/target",
      after: "/en/new/tree/target",
    }),
  );
  await directories.move("en", {
    fromPath: preview.fromPath,
    toPath: preview.toPath,
    expectedVersion: preview.version,
    expectedMembers: preview.members.map(({ id, version }) => ({
      id,
      version,
    })),
  });
  expect(
    await env.DB.prepare("SELECT * FROM page_revisions ORDER BY id").all(),
  ).toMatchObject({ results: revisions.results });
  expect((await content.getDetail(zh.id)).translation.path).toBe(
    "source/child",
  );
  expect((await getPage(env.DB, "en", "source"))?.id).toBe(landing.id);
  expect((await getPage(env.DB, "en", "source/child"))?.path).toBe(
    "new/tree/child",
  );
  expect(JSON.stringify(await getNavigation(env.DB, "en"))).toContain(
    "/en/new/tree/child",
  );
  expect(
    (await searchPages(env.DB, "en", "acceptance")).some(
      (result) => result.path === "/en/new/tree/child",
    ),
  ).toBe(true);
  expect((await content.getDetail(outside.id)).draft.linkBasePath).toBe(
    "outside/ref",
  );
});

it("blocks an unreviewable link list and stale requests without any partial movement", async () => {
  const source = await page(
    "blocked/source",
    Array.from({ length: 257 }, (_, i) => `[link${i}](./target${i})`).join(
      "\n",
    ),
  );
  await expect(
    content.move(source.id, source.version, "elsewhere/source"),
  ).rejects.toMatchObject({ status: 409 });
  expect((await content.getDetail(source.id)).translation.path).toBe(
    "blocked/source",
  );
  const other = await page("stale/source");
  const preview = await directories.preview("en", {
    fromPath: "stale",
    toPath: "new/stale",
  });
  await content.saveDraft(other.id, other.version, body);
  await expect(
    directories.move("en", {
      fromPath: preview.fromPath,
      toPath: preview.toPath,
      expectedVersion: preview.version,
      expectedMembers: preview.members.map(({ id, version }) => ({
        id,
        version,
      })),
    }),
  ).rejects.toMatchObject({ status: 412 });
  expect((await content.getDetail(other.id)).translation.path).toBe(
    "stale/source",
  );
  await expect(
    env.DB.prepare("UPDATE revision_link_bases SET path='evil'").run(),
  ).rejects.toThrow();
});

it("keeps URL normalization same-origin and protects the new preview route", async () => {
  const resolved = resolveRelativeLink(
    "../../..//outside.example/path",
    "en",
    "source/article",
  );
  const url = new URL(resolved, "https://cf.emby.wiki/en/elsewhere/page");
  expect(url.origin).toBe("https://cf.emby.wiki");
  expect(url.pathname).toBe("//outside.example/path");
  const source = await page("protected/source");
  const endpoint = `https://example.com/api/admin/pages/${source.id}/move-preview`;
  const headers = {
    Origin: "https://example.com",
    "Content-Type": "application/json",
    Cookie: `__Host-wiki_session=${fixtureSessionToken}`,
    "X-CSRF-Token": await sha256(`csrf:${fixtureSessionToken}`),
  };
  const init = {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedVersion: source.version, path: "new/path" }),
  };
  expect((await exports.default.fetch(endpoint, init)).status).toBe(200);
  expect(
    (
      await exports.default.fetch(endpoint, {
        ...init,
        headers: { ...headers, Cookie: "" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await exports.default.fetch(endpoint, {
        ...init,
        headers: { ...headers, "X-CSRF-Token": "wrong" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await exports.default.fetch(`${endpoint}?unexpected=1`, init)).status,
  ).toBe(400);
});
