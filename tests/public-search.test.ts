import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Language } from "../shared/contracts";
import {
  getPage,
  searchPages as searchPublishedPages,
} from "../worker/content/public";

const searchPages = (language: Language, query: string) =>
  searchPublishedPages(env.DB, language, query);

describe("public catalog search", () => {
  it("shows readable excerpts instead of Markdown table and link syntax", async () => {
    const results = await searchPages("en", "Markdown");
    for (const result of results) {
      expect(result.excerpt).not.toMatch(/\[\[|\]\]|\|\s*\||~~/);
      expect(result.tags.join(" ")).not.toMatch(/[\u4e00-\u9fff]/u);
    }
    expect(
      results.find((result) => result.path === "/en/home")?.excerpt,
    ).toContain("Markdown reference");
  });
  it("ranks a title match above the same word in article bodies", async () => {
    const results = await searchPages("en", "Markdown");
    expect(results[0]?.path).toBe("/en/guide/markdown");
    // Both articles mention Markdown in their body, so this exercises ranking
    // rather than merely returning the only match.
    expect(results.some((result) => result.path === "/en/home")).toBe(true);
    expect(results.some((result) => result.path === "/en/guide/reading")).toBe(
      true,
    );
  });

  it("ranks a metadata tag match above body-only matches", async () => {
    const results = await searchPages("en", "code");
    expect(results[0]?.path).toBe("/en/guide/markdown");
    expect(results[0]?.tags).toContain("code");
    expect(results.length).toBeGreaterThan(1);
  });

  it.each(["zh", "en"] as const)(
    "keeps every result in the requested %s language",
    async (language) => {
      const results = await searchPages(language, "Markdown");
      expect(results.length).toBeGreaterThan(1);
      for (const result of results) {
        expect(result.path.startsWith(`/${language}/`)).toBe(true);
        const page = await getPage(env.DB, language, result.path.slice(4));
        expect(result.title).toBe(page?.title);
        expect(result.description).toBe(page?.description);
      }
    },
  );

  it("requires every query term while allowing matches across different fields", async () => {
    expect(
      (await searchPages("en", "Markdown clipboard")).map(
        (result) => result.path,
      ),
    ).toEqual(["/en/guide/reading"]);
    // Markdown matches the title; code matches the tags and description.
    expect((await searchPages("en", "Markdown code"))[0]?.path).toBe(
      "/en/guide/markdown",
    );
    expect(
      await searchPages("en", "Markdown definitely-not-in-the-catalog"),
    ).toEqual([]);
  });

  it("normalizes Unicode width, letter case and full-width query whitespace", async () => {
    expect(await searchPages("en", "ＭＡＲＫＤＯＷＮ")).toEqual(
      await searchPages("en", "markdown"),
    );
    expect(await searchPages("zh", "Ｍａｒｋｄｏｗｎ　ｃｏｄｅ")).toEqual(
      await searchPages("zh", "markdown code"),
    );
  });

  it("ignores punctuation instead of evaluating regex or FTS syntax", async () => {
    expect(await searchPages("en", ".*")).toEqual([]);
    expect(await searchPages("en", "[")).toEqual([]);
    expect(await searchPages("en", '"Markdown"*')).toEqual(
      await searchPages("en", "Markdown"),
    );
  });

  it("does not interpret query operators, SQL or HTML as search commands", async () => {
    for (const [query, words] of [
      ['" OR 1=1 --', "OR 1 1"],
      ["title:Markdown", "title Markdown"],
      ["<script>alert(1)</script>", "script alert 1 script"],
      ["Markdown|absenttoken", "Markdown absenttoken"],
    ] as const)
      expect(
        (await searchPages("en", query)).map((result) => result.path),
      ).toEqual((await searchPages("en", words)).map((result) => result.path));
    expect(await searchPages("en", "Markdown|absenttoken")).toEqual([]);
    expect(await searchPages("en", " \t\n ")).toEqual([]);
  });
});
