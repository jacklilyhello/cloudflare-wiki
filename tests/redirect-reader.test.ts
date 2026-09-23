import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminTranslation } from "../shared/content";
import type { Language } from "../shared/contracts";
import { publicPath } from "../shared/paths";
import type { ReaderData, SearchResult } from "../shared/reader";
import type { ContentService } from "../worker/content/service";
import { RedirectService } from "../worker/redirects/service";
import { contentFixture } from "./content-fixture";

let content: ContentService;
let redirects: RedirectService;
beforeEach(async () => {
  const fixture = await contentFixture(env.DB);
  content = fixture.service;
  redirects = new RedirectService(env.DB, fixture.access);
});

function word() {
  return `alias${crypto.randomUUID().replace(/-/g, "")}`;
}
function request(path: string, method = "GET") {
  return exports.default.fetch(`https://untrusted-host.example${path}`, {
    method,
    redirect: "manual",
  });
}
async function create(language: Language = "en", path = word()) {
  return content.createTranslation({
    language,
    path,
    title: word(),
    description: "Published redirect target",
    markdown: "## Public section\n\nPublic documentation.",
    tags: [],
  });
}
function publish(page: AdminTranslation) {
  return content.publish(page.id, page.version, page.draftRevisionId ?? "");
}
async function alias(page: AdminTranslation, path = word()) {
  return redirects.create(page.language, {
    expectedVersion: (await redirects.list(page.language)).version,
    path,
    translationId: page.id,
  });
}
async function location(path: string, expected: string) {
  for (const method of ["GET", "HEAD"]) {
    const response = await request(
      `${path}?next=https://outside.example`,
      method,
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(expected);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("");
  }
}

describe("managed aliases at the public reader boundary", () => {
  it("resolves every historical and manual alias directly after successive Unicode moves", async () => {
    let page = await publish(await create("zh", `${word()}/开始`));
    const original = page.path;
    const manual = await alias(page, `${word()}/旧链接`);
    const intermediate = `${word()}/移动`;
    page = await content.move(page.id, page.version, intermediate);
    page = await content.move(page.id, page.version, `${word()}/当前`);
    const canonical = publicPath("zh", page.path);
    for (const path of [original, manual.item.path, intermediate])
      await location(publicPath("zh", path), canonical);
    expect((await request(canonical)).status).toBe(200);
  });

  it("keeps the same alias source independent in Chinese and English", async () => {
    const source = word();
    const zh = await publish(await create("zh"));
    const en = await publish(await create("en"));
    await alias(zh, source);
    await alias(en, source);
    await location(publicPath("zh", source), publicPath("zh", zh.path));
    await location(publicPath("en", source), publicPath("en", en.path));
    expect((await request(`/fr/${source}`)).status).toBe(404);
  });

  it("does not disclose draft, unpublished, deleted or merely restored targets", async () => {
    let page = await create();
    const manual = await alias(page);
    const source = publicPath("en", manual.item.path);
    const hidden = async () => {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(source, method);
        expect(response.status).toBe(404);
        expect(response.headers.get("Location")).toBeNull();
        const body = await response.text();
        expect(body).not.toContain(page.id);
        if (method === "HEAD") expect(body).toBe("");
      }
    };
    await hidden();
    page = await publish(page);
    await location(source, publicPath("en", page.path));
    page = await content.unpublish(page.id, page.version);
    await hidden();
    page = await publish(page);
    page = await content.softDelete(page.id, page.version);
    await hidden();
    page = await content.restoreDeleted(page.id, page.version);
    await hidden();
    page = await publish(page);
    await location(source, publicPath("en", page.path));
  });

  it("retargets, renames and removes aliases without changing either article", async () => {
    const first = await publish(await create());
    const second = await publish(await create());
    const manual = await alias(first);
    let updated = await redirects.update("en", {
      expectedVersion: manual.version,
      sourcePath: manual.item.path,
      path: manual.item.path,
      translationId: second.id,
    });
    await location(
      publicPath("en", manual.item.path),
      publicPath("en", second.path),
    );
    const newSource = word();
    updated = await redirects.update("en", {
      expectedVersion: updated.version,
      sourcePath: updated.item.path,
      path: newSource,
      translationId: second.id,
    });
    expect((await request(publicPath("en", manual.item.path))).status).toBe(
      404,
    );
    await location(publicPath("en", newSource), publicPath("en", second.path));
    await redirects.delete("en", {
      expectedVersion: updated.version,
      sourcePath: newSource,
    });
    expect((await request(publicPath("en", newSource))).status).toBe(404);
    for (const page of [first, second])
      expect((await request(publicPath("en", page.path))).status).toBe(200);
  });

  it("uses only canonical paths in search, navigation and the sitemap", async () => {
    const page = await publish(await create());
    const manual = await alias(page);
    const canonical = publicPath("en", page.path);
    const source = publicPath("en", manual.item.path);
    const sitemap = await (await request("/sitemap.xml")).text();
    expect(sitemap).toContain(`https://cf.emby.wiki${canonical}`);
    expect(sitemap).not.toContain(source);
    const search = await request(`/api/public/search?lang=en&q=${page.path}`);
    const results = ((await search.json()) as { results: SearchResult[] })
      .results;
    expect(results.map((result) => result.path)).toEqual([canonical]);
    const aliasSearch = await request(
      `/api/public/search?lang=en&q=${manual.item.path}`,
    );
    expect(
      ((await aliasSearch.json()) as { results: SearchResult[] }).results,
    ).toEqual([]);
    const html = await (await request(canonical)).text();
    const encoded =
      /<script id="reader-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1];
    expect(encoded).toBeDefined();
    const reader = JSON.parse(encoded ?? "null") as ReaderData;
    expect(reader.page?.path).toBe(page.path);
    expect(JSON.stringify(reader.navigation)).toContain(canonical);
    expect(JSON.stringify(reader.navigation)).not.toContain(source);
    expect(html).toContain(
      `rel="canonical" href="https://cf.emby.wiki${canonical}"`,
    );
  });

  it("does not let a visitor mutate or evaluate an alias through document requests", async () => {
    const page = await publish(await create());
    const manual = await alias(page);
    const source = publicPath("en", manual.item.path);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await request(source, method)).status).toBe(405);
    await location(source, publicPath("en", page.path));
    expect((await request(`${source}%2fextra`)).status).toBe(400);
  });
});
