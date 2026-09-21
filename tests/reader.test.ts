import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AdminTranslation,
  CreateTranslationInput,
} from "../shared/content";
import { publicPath } from "../shared/paths";
import type { ReaderData, SearchResult } from "../shared/reader";
import type { ContentService } from "../worker/content/service";
import { publicSearch, renderReader, sitemap } from "../worker/reader";
import { contentFixture } from "./content-fixture";

let service: ContentService;
beforeEach(async () => {
  ({ service } = await contentFixture(env.DB));
});

function uniqueWord(prefix: string) {
  return prefix + crypto.randomUUID().replace(/-/g, "");
}

function readData(html: string): ReaderData {
  const data =
    /<script id="reader-data" type="application\/json">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
  expect(data).toBeDefined();
  return JSON.parse(data ?? "null") as ReaderData;
}

async function request(path: string, method = "GET") {
  return exports.default.fetch(`https://example.com${path}`, {
    method,
    redirect: "manual",
  });
}

async function create(input: Partial<CreateTranslationInput> = {}) {
  const word = uniqueWord("readerpublication");
  return service.createTranslation({
    language: "zh",
    path: `test-${word}`,
    title: word,
    description: "Public description",
    markdown: `## Published section\n\n${word} published content.`,
    tags: [word],
    ...input,
  });
}

async function publish(state: AdminTranslation) {
  expect(state.draftRevisionId).not.toBeNull();
  return service.publish(state.id, state.version, state.draftRevisionId ?? "");
}

async function search(language: "zh" | "en", query: string) {
  const response = await request(
    `/api/public/search?lang=${language}&q=${encodeURIComponent(query)}`,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { results: SearchResult[] }).results;
}

describe("D1 public publication boundary", () => {
  it("never exposes unpublished content or draft changes through any reader surface", async () => {
    const privateWord = uniqueWord("privatedraft");
    let state = await create();
    const path = publicPath(state.language, state.path);
    const draftTranslation = await create({
      pageId: state.pageId,
      language: "en",
      title: privateWord,
      description: privateWord,
      markdown: privateWord,
      tags: [privateWord],
    });
    expect((await request(path)).status).toBe(404);
    expect(
      (await request(publicPath("en", draftTranslation.path))).status,
    ).toBe(404);
    expect(await search("en", privateWord)).toEqual([]);
    const beforeHome = readData(await (await request("/zh/home")).text());
    expect(JSON.stringify(beforeHome.navigation)).not.toContain(state.path);
    expect(await (await request("/sitemap.xml")).text()).not.toContain(
      state.path,
    );

    state = await publish(state);
    const published = readData(await (await request(path)).text());
    expect(published.translations).toEqual({ zh: path });
    state = await service.saveDraft(state.id, state.version, {
      title: privateWord,
      description: privateWord,
      markdown: `## Private heading\n\n${privateWord}`,
      tags: [privateWord],
      changeNote: privateWord,
    });
    expect(state.draftRevisionId).not.toBe(state.publishedRevisionId);

    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    const visible = readData(html);
    expect(visible.page).toEqual(published.page);
    expect(html).not.toContain(privateWord);
    expect(JSON.stringify(visible)).not.toContain("draftRevisionId");
    expect(JSON.stringify(visible.navigation)).toContain(published.page?.title);
    expect(await search("zh", privateWord)).toEqual([]);
    expect(await search("en", privateWord)).toEqual([]);
    expect(
      await (await request(`/zh/search?q=${privateWord}`)).text(),
    ).not.toContain("Private heading");
    expect(await (await request("/sitemap.xml")).text()).not.toContain(
      draftTranslation.path,
    );
  });

  it("redirects historical Unicode routes only while the current translation is published", async () => {
    const base = uniqueWord("movepublication");
    let state = await publish(
      await create({ path: `${base}/旧版`, title: base }),
    );
    await publish(
      await create({
        pageId: state.pageId,
        language: "en",
        path: `${base}/english`,
        title: base,
      }),
    );
    const originalPath = publicPath("zh", state.path);
    state = await service.move(state.id, state.version, `${base}/中间版`);
    const intermediatePath = publicPath("zh", state.path);
    state = await service.move(state.id, state.version, `${base}/最终版`);
    const canonicalPath = publicPath("zh", state.path);

    for (const oldPath of [originalPath, intermediatePath]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(oldPath, method);
        expect(response.status).toBe(301);
        expect(response.headers.get("Location")).toBe(canonicalPath);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.text()).toBe("");
      }
    }
    const canonicalHtml = await (await request(canonicalPath)).text();
    const visible = readData(canonicalHtml);
    expect(visible.translations).toEqual({
      zh: canonicalPath,
      en: `/en/${base}/english`,
    });
    expect(JSON.stringify(visible.navigation)).toContain(canonicalPath);
    expect(JSON.stringify(visible.navigation)).not.toContain(originalPath);
    expect(canonicalHtml).toContain(
      `href="${canonicalPath}" aria-current="page"`,
    );
    expect(canonicalHtml).toMatch(/<details class="navigation-group" open="">/);
    expect(canonicalHtml).toMatch(
      new RegExp(`<span aria-current="page">${base}</span>`),
    );
    expect(canonicalHtml).toContain('class="page-pagination"');
    expect((await search("zh", base))[0]?.path).toBe(canonicalPath);
    const xml = await (await request("/sitemap.xml")).text();
    expect(xml).toContain(`https://cf.emby.wiki${canonicalPath}`);
    expect(xml).not.toContain(originalPath);

    state = await service.unpublish(state.id, state.version);
    for (const path of [originalPath, intermediatePath, canonicalPath]) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("Location")).toBeNull();
    }
    expect(await search("zh", base)).toEqual([]);
    const english = readData(
      await (await request(`/en/${base}/english`)).text(),
    );
    expect(english.translations.zh).toBeUndefined();
    expect(await (await request("/sitemap.xml")).text()).not.toContain(
      canonicalPath,
    );

    state = await publish(state);
    state = await service.softDelete(state.id, state.version);
    expect((await request(originalPath)).status).toBe(404);
    expect((await request(canonicalPath)).status).toBe(404);
    expect(await search("zh", base)).toEqual([]);
    state = await service.restoreDeleted(state.id, state.version);
    expect(state.publishedRevisionId).toBeNull();
    expect((await request(canonicalPath)).status).toBe(404);
  });

  it("rejects stale index rows that do not match the current published revision", async () => {
    const word = uniqueWord("stalesearch");
    let state = await publish(await create({ title: word, markdown: word }));
    const privateWord = uniqueWord("secretrevision");
    state = await service.saveDraft(state.id, state.version, {
      title: privateWord,
      description: privateWord,
      markdown: privateWord,
      tags: [privateWord],
    });
    await env.DB.prepare(
      "UPDATE published_search SET revision_id = ?, title = ?, body_text = ? WHERE translation_id = ?",
    )
      .bind(state.draftRevisionId, privateWord, privateWord, state.id)
      .run();
    expect(await search("zh", word)).toEqual([]);
    expect(await search("zh", privateWord)).toEqual([]);
    const response = await request(publicPath("zh", state.path));
    const html = await response.text();
    expect(readData(html).page?.title).toBe(word);
    expect(html).not.toContain(privateWord);
  });

  it("escapes stored metadata and sanitizes stored Markdown before SSR and hydration", async () => {
    const attack = '</script><img src=x onerror="alert(1)">';
    const state = await publish(
      await create({
        title: attack,
        description: attack,
        markdown:
          "## Safe heading\n\n<script>alert(1)</script>\n\nSafe article.",
        tags: ["<svg onload=alert(1)>"],
      }),
    );
    const response = await request(publicPath("zh", state.path));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(attack);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<svg onload");
    expect(html).toContain("&lt;/script&gt;");
    const data = readData(html);
    expect(data.page?.title).toBe(attack);
    expect(data.rendered?.html).toContain("Safe article.");
    expect(data.rendered?.html).not.toContain("<script");
  });

  it.each(["/zh/test%2fhome", "/zh/test%5chome", "/zh/%00", "/zh/%ZZ"])(
    "rejects ambiguous encoded document path %s",
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    },
  );
});

describe("unavailable publication storage", () => {
  it("fails closed with sanitized no-store 503 responses without a static fallback", async () => {
    const privateFailure = "D1_ERROR private database location and credential";
    const db = {
      prepare() {
        throw new Error(privateFailure);
      },
    } as unknown as D1Database;
    const unavailableEnv = { ...env, DB: db } as Env;
    for (const method of ["GET", "HEAD"]) {
      const handlers = [
        [renderReader, "/zh/home"],
        [publicSearch, "/api/public/search?lang=zh&q=Markdown"],
        [sitemap, "/sitemap.xml"],
      ] as const;
      for (const [handler, path] of handlers) {
        const response = await handler(
          new Request(`https://example.com${path}`, { method }),
          unavailableEnv,
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(response.headers.get("Content-Type")).toContain(
          "application/json",
        );
        const body = await response.text();
        expect(body).not.toContain(privateFailure);
        expect(body).not.toContain("Emby 技术文档");
        if (method === "HEAD") expect(body).toBe("");
        else
          expect(JSON.parse(body)).toEqual({
            error: "Content temporarily unavailable",
          });
      }
    }
  });
});
