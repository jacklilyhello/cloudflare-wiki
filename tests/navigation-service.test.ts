import { applyD1Migrations, type D1Migration, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Language } from "../shared/contracts";
import { NAVIGATION_LIMITS, type NavigationNode } from "../shared/navigation";
import type { ContentWriteAccess } from "../worker/auth/access";
import type { ContentService } from "../worker/content/service";
import { getPublicNavigation } from "../worker/navigation/public";
import { NavigationService } from "../worker/navigation/service";
import { contentFixture } from "./content-fixture";

let service: NavigationService;
let content: ContentService;
let access: ContentWriteAccess;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    env.DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
  const fixture = await contentFixture(env.DB);
  access = fixture.access;
  content = fixture.service;
  service = new NavigationService(env.DB, access);
});
function node(overrides: Partial<NavigationNode> = {}): NavigationNode {
  return {
    id: crypto.randomUUID(),
    parentId: null,
    position: 0,
    kind: "group",
    label: "A group",
    translationId: null,
    externalUrl: null,
    ...overrides,
  };
}
function page(id = "starter-home-en", overrides: Partial<NavigationNode> = {}) {
  return node({ kind: "page", label: null, translationId: id, ...overrides });
}
function link(overrides: Partial<NavigationNode> = {}) {
  return node({
    kind: "link",
    label: "External reference",
    externalUrl: "https://example.com/docs",
    ...overrides,
  });
}
async function save(
  nodes: NavigationNode[],
  expectedVersion = 1,
  language: Language = "en",
) {
  return service.save(language, { expectedVersion, mode: "custom", nodes });
}
async function snapshot() {
  const rows = await env.DB.batch([
    env.DB.prepare("SELECT * FROM navigation_trees ORDER BY language"),
    env.DB.prepare("SELECT * FROM navigation_nodes ORDER BY language,id"),
  ]);
  return rows.map((row) => row.results);
}
async function article(path: string, title = "Published title") {
  let state = await content.createTranslation({
    language: "en",
    path,
    title,
    description: "",
    markdown: "Body",
    tags: [],
  });
  state = await content.publish(
    state.id,
    state.version,
    state.draftRevisionId ?? "",
  );
  return state;
}
async function publishedFixtures(paths: string[]) {
  const fixtures = paths.map((slug, index) => ({
    id: `navigation-bulk-${index}`,
    slug,
  }));
  const json = JSON.stringify(fixtures);
  const timestamp = "2026-09-21T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pages(id,created_at) SELECT json_extract(value,'$.id'),? FROM json_each(?)",
    ).bind(timestamp, json),
    env.DB.prepare(
      "INSERT INTO page_translations(id,page_id,language,slug,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.id'),'en',json_extract(value,'$.slug'),?,? FROM json_each(?)",
    ).bind(timestamp, timestamp, json),
    env.DB.prepare(
      "INSERT INTO page_revisions(id,translation_id,revision_no,title,description,markdown,tags_json,change_note,created_at) SELECT json_extract(value,'$.id')||'-r1',json_extract(value,'$.id'),1,'Fixture publication','','','[]','',? FROM json_each(?)",
    ).bind(timestamp, json),
    env.DB.prepare(
      "UPDATE page_translations SET draft_revision_id=id||'-r1',published_revision_id=id||'-r1',published_at=?,revision_seq=1,write_version=1 WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))",
    ).bind(timestamp, json),
  ]);
}

describe("navigation forest transactions in workerd", () => {
  it("starts with independent automatic trees and keeps saved custom nodes while automatic", async () => {
    const en = await service.get("en");
    const zh = await service.get("zh");
    expect(en).toMatchObject({
      language: "en",
      version: 1,
      mode: "automatic",
      nodes: [],
    });
    expect(zh).toMatchObject({
      language: "zh",
      version: 1,
      mode: "automatic",
      nodes: [],
    });
    expect(
      en.automaticNodes?.filter((entry) => entry.kind === "page"),
    ).toHaveLength(3);
    expect(en.targets.every((target) => target.language === "en")).toBe(true);
    expect(JSON.stringify(en)).not.toContain('"markdown"');
    expect(await getPublicNavigation(env.DB, "en")).toBeNull();
    const nodes = [
      node({ id: "kept" }),
      page("starter-home-en", { parentId: "kept" }),
    ];
    const custom = await save(nodes);
    const automatic = await service.save("en", {
      expectedVersion: custom.version,
      mode: "automatic",
      nodes: custom.nodes,
    });
    expect(automatic.nodes).toEqual(custom.nodes);
    expect((await service.get("en")).nodes).toEqual(custom.nodes);
    expect(await getPublicNavigation(env.DB, "en")).toBeNull();
    expect((await service.get("zh")).version).toBe(1);
    await save([], automatic.version);
    expect(await getPublicNavigation(env.DB, "en")).toEqual([]);
  });

  it("normalizes sibling order and keeps stable IDs across reordering and reparenting", async () => {
    const group = node({ id: "parent", position: 20, label: " Group " });
    const first = link({ id: "first", position: 50 });
    const last = page("starter-home-en", {
      id: "last",
      parentId: "parent",
      position: 9,
    });
    const document = await save([last, first, group]);
    expect(document.nodes.map((entry) => [entry.id, entry.position])).toEqual([
      ["parent", 0],
      ["last", 0],
      ["first", 1],
    ]);
    expect(document.nodes[0]?.label).toBe("Group");
    expect(group.label).toBe(" Group ");
    const changed = await save(
      [
        node({ id: "parent", position: 1 }),
        page("starter-home-en", { id: "last", position: 0 }),
        link({ id: "first", parentId: "parent" }),
      ],
      document.version,
    );
    expect(changed.nodes.map((entry) => entry.id)).toEqual([
      "last",
      "parent",
      "first",
    ]);
    expect((await service.get("en")).nodes).toEqual(changed.nodes);
  });

  it("accepts only one competing replacement and leaves no nodes from the losing batch", async () => {
    const results = await Promise.allSettled([
      save([link({ id: "winner-a" })]),
      save([link({ id: "winner-b" })]),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" && failure.reason.status).toBe(412);
    const winner = results.find((result) => result.status === "fulfilled");
    const document = await service.get("en");
    expect(document.version).toBe(2);
    expect(document.nodes).toEqual(
      winner?.status === "fulfilled" && winner.value.nodes,
    );
    const before = await snapshot();
    await expect(save([link()], 1)).rejects.toMatchObject({ status: 412 });
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back deletion and insertion when the final tree update fails", async () => {
    await save([link({ id: "original" })]);
    const before = await snapshot();
    await env.DB.exec(
      "CREATE TRIGGER navigation_fixture_failure BEFORE UPDATE ON navigation_trees BEGIN SELECT RAISE(ABORT,'fixture_only'); END;",
    );
    await expect(save([link({ id: "replacement" })], 2)).rejects.toThrow(
      "Navigation storage operation failed.",
    );
    expect(await snapshot()).toEqual(before);
  });

  it.each(["logout", "credentials"] as const)(
    "leaves the previous forest intact when %s happens immediately before the replacement batch",
    async (kind) => {
      await save([
        node({ id: "original" }),
        page("starter-home-en", { parentId: "original" }),
      ]);
      const before = await snapshot();
      const raced = new NavigationService(
        new Proxy(env.DB, {
          get(target, key) {
            if (key === "batch")
              return async (statements: D1PreparedStatement[]) => {
                if (statements.length === 3) {
                  if (kind === "logout")
                    await target
                      .prepare("DELETE FROM admin_sessions WHERE token_hash=?")
                      .bind(access.tokenHash)
                      .run();
                  else
                    await target
                      .prepare(
                        "UPDATE administrators SET password_hash='invalid-fixture-verifier',auth_version=auth_version+1 WHERE id=1",
                      )
                      .run();
                }
                return target.batch(statements);
              };
            const member = Reflect.get(target, key, target);
            return typeof member === "function" ? member.bind(target) : member;
          },
        }),
        access,
      );
      await expect(
        raced.save("en", {
          expectedVersion: 2,
          mode: "custom",
          nodes: [link({ id: "forbidden" })],
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(await snapshot()).toEqual(before);
      await expect(service.get("en")).rejects.toMatchObject({ status: 401 });
    },
  );

  it("rejects missing or forged session access and expired sessions", async () => {
    expect(
      () =>
        new NavigationService(
          env.DB,
          undefined as unknown as ContentWriteAccess,
        ),
    ).toThrow("Authentication required.");
    await expect(
      new NavigationService(env.DB, {
        ...access,
        authVersion: access.authVersion + 1,
      }).get("en"),
    ).rejects.toMatchObject({ status: 401 });
    await env.DB.prepare(
      "UPDATE admin_sessions SET created_at=?,last_seen_at=? WHERE token_hash=?",
    )
      .bind(Date.now() - 3_600_000, Date.now() - 1_800_001, access.tokenHash)
      .run();
    await expect(service.get("en")).rejects.toMatchObject({ status: 401 });
    await expect(save([])).rejects.toMatchObject({ status: 401 });
  });

  it("returns 404 for missing page/tree references and refuses cross-language references", async () => {
    const before = await snapshot();
    await expect(save([page("does-not-exist")])).rejects.toMatchObject({
      status: 404,
    });
    await expect(save([page("starter-home-zh")])).rejects.toMatchObject({
      status: 400,
    });
    expect(await snapshot()).toEqual(before);
    await env.DB.prepare(
      "DELETE FROM navigation_trees WHERE language='en'",
    ).run();
    await expect(service.get("en")).rejects.toMatchObject({ status: 404 });
    await expect(getPublicNavigation(env.DB, "en")).rejects.toThrow(
      "Navigation storage operation failed.",
    );
  });
});

describe("navigation validation limits", () => {
  it("rejects cycles, orphan parents, leaf parents, duplicate IDs/pages/sibling positions, and mixed kinds", async () => {
    const invalid = [
      [node({ id: "loop", parentId: "loop" })],
      [node({ id: "a", parentId: "b" }), node({ id: "b", parentId: "a" })],
      [node({ parentId: "absent" })],
      [page("starter-home-en", { id: "leaf" }), node({ parentId: "leaf" })],
      [node({ id: "same" }), node({ id: "same", position: 1 })],
      [page(), page("starter-home-en", { position: 1 })],
      [node(), link()],
      [node({ translationId: "starter-home-en" })],
      [link({ label: null })],
      [page("starter-home-en", { externalUrl: "https://example.com" })],
      [node({ position: 0.5 })],
      [node({ label: " " })],
      [node({ label: "x".repeat(201) })],
    ];
    const before = await snapshot();
    for (const nodes of invalid)
      await expect(save(nodes)).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "//example.com/a",
    "/zh/home",
    "https://owner:secret@example.com",
    "https://owner@example.com",
    "https://example.com/\nheader",
    "https://example.com/%0aheader",
    "https://example.com/%00",
    "https://example.com\\@attacker.invalid",
    " https://example.com",
    "https://",
    `https://example.com/${"x".repeat(2048)}`,
  ])("rejects unsafe external URL %s", async (url) => {
    await expect(save([link({ externalUrl: url })])).rejects.toMatchObject({
      status: 400,
    });
    expect((await service.get("en")).version).toBe(1);
  });

  it("accepts canonical HTTP(S) links while preserving safe encoded paths and fragment text", async () => {
    const saved = await save([
      link({
        externalUrl: "HTTPS://Example.COM/docs%20folder?q=value#section",
      }),
      link({ position: 1, externalUrl: "http://example.com" }),
    ]);
    expect(saved.nodes.map((entry) => entry.externalUrl)).toEqual([
      "https://example.com/docs%20folder?q=value#section",
      "http://example.com/",
    ]);
  });

  it("supports exactly 300 nodes through one JSON binding and rejects the next node", async () => {
    const nodes = Array.from(
      { length: NAVIGATION_LIMITS.nodes },
      (_, position) => link({ id: `item-${position}`, position }),
    );
    const saved = await save(nodes);
    expect(saved.nodes).toHaveLength(300);
    expect(await getPublicNavigation(env.DB, "en")).toHaveLength(300);
    const before = await snapshot();
    await expect(
      save([...nodes, link({ position: 300 })], saved.version),
    ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it("accepts eight levels and rejects a ninth without altering the tree", async () => {
    const nodes = Array.from({ length: 8 }, (_, index) =>
      node({
        id: `depth-${index}`,
        parentId: index ? `depth-${index - 1}` : null,
      }),
    );
    const saved = await save(nodes);
    expect(saved.nodes).toHaveLength(8);
    const before = await snapshot();
    await expect(
      save([...nodes, node({ parentId: "depth-7" })], saved.version),
    ).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
});

describe("publication-only navigation projection", () => {
  it("uses the published title, prunes private pages and empty groups, follows moves, and remains unpublished after restore", async () => {
    let published = await article("navigation-public");
    const privatePage = await content.createTranslation({
      language: "en",
      path: "navigation-private",
      title: "PRIVATE UNPUBLISHED CANARY",
      description: "",
      markdown: "Private",
      tags: [],
    });
    published = await content.saveDraft(published.id, published.version, {
      title: "PRIVATE NEW DRAFT TITLE",
      description: "",
      markdown: "Private changed source",
      tags: [],
    });
    const saved = await save([
      node({ id: "visible", label: "Visible" }),
      page(published.id, { id: "public", parentId: "visible" }),
      node({ id: "hidden", position: 1, label: "Private group" }),
      page(privatePage.id, { parentId: "hidden", label: "Hidden override" }),
      link({ id: "external", position: 2 }),
    ]);
    expect(
      saved.targets.find((target) => target.id === published.id),
    ).toMatchObject({
      draftTitle: "PRIVATE NEW DRAFT TITLE",
      publishedTitle: "Published title",
      deleted: false,
    });
    const result = await getPublicNavigation(env.DB, "en");
    expect(result?.map((entry) => entry.id)).toEqual(["visible", "external"]);
    expect(result?.[0]?.children?.[0]).toMatchObject({
      id: "public",
      kind: "page",
      title: "Published title",
      path: "/en/navigation-public",
      external: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|Hidden override|Private group/,
    );
    published = await content.move(
      published.id,
      published.version,
      "navigation-moved",
    );
    expect(
      (await getPublicNavigation(env.DB, "en"))?.[0]?.children?.[0]?.path,
    ).toBe("/en/navigation-moved");
    published = await content.softDelete(published.id, published.version);
    expect(
      (await getPublicNavigation(env.DB, "en"))?.map((entry) => entry.id),
    ).toEqual(["external"]);
    expect(
      (await service.get("en")).targets.find(
        (target) => target.id === published.id,
      ),
    ).toMatchObject({ deleted: true, publishedTitle: null });
    published = await content.restoreDeleted(published.id, published.version);
    expect(
      (await getPublicNavigation(env.DB, "en"))?.map((entry) => entry.id),
    ).toEqual(["external"]);
    published = await content.publish(
      published.id,
      published.version,
      published.draftRevisionId ?? "",
    );
    expect(
      (await getPublicNavigation(env.DB, "en"))?.[0]?.children?.[0]?.title,
    ).toBe("PRIVATE NEW DRAFT TITLE");
    await content.unpublish(published.id, published.version);
    expect(
      (await getPublicNavigation(env.DB, "en"))?.map((entry) => entry.id),
    ).toEqual(["external"]);
    expect(await getPublicNavigation(env.DB, "zh")).toBeNull();
  });

  it("generates a convertible tree when a published path is also a folder", async () => {
    const overview = await article("guide", "Guide overview");
    const document = await service.get("en");
    const group = document.automaticNodes?.find(
      (entry) => entry.kind === "group" && entry.label === "Guides",
    );
    expect(group).toBeDefined();
    expect(
      document.automaticNodes?.find(
        (entry) => entry.translationId === overview.id,
      )?.parentId,
    ).toBe(group?.id);
    const custom = await save(document.automaticNodes ?? []);
    expect(custom.nodes.filter((entry) => entry.kind === "page")).toHaveLength(
      4,
    );
    expect(JSON.stringify(await getPublicNavigation(env.DB, "en"))).toContain(
      "Guide overview",
    );
  });

  it.each(["pages", "folders", "depth"] as const)(
    "returns no partial automatic starting tree when the %s limit is exceeded",
    async (kind) => {
      if (kind === "pages")
        await publishedFixtures(
          Array.from({ length: 301 }, (_, index) => `bulk-${index}`),
        );
      else if (kind === "folders")
        await publishedFixtures(
          Array.from({ length: 149 }, (_, index) => `bulk-${index}/article`),
        );
      else await publishedFixtures(["a/b/c/d/e/f/g/h/i"]);
      const document = await service.get("en");
      expect(document.automaticNodes).toBeNull();
      expect(document.nodes).toEqual([]);
      expect(document.targets).toEqual([]);
      expect(await getPublicNavigation(env.DB, "en")).toBeNull();
    },
  );
});
