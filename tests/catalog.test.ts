import { describe, expect, it } from "vitest";
import { publishedPages, searchPages } from "../worker/content/catalog";

describe("public catalog search", () => {
  it("shows readable excerpts instead of Markdown table and link syntax", () => {
    const results = searchPages("en", "Markdown");
    for (const result of results) {
      expect(result.excerpt).not.toMatch(/\[\[|\]\]|\|\s*\||~~/);
      expect(result.tags.join(" ")).not.toMatch(/[\u4e00-\u9fff]/u);
    }
    expect(
      results.find((result) => result.path === "/en/home")?.excerpt,
    ).toContain("Markdown reference");
  });
  it("ranks a title match above the same word in article bodies", () => {
    const results = searchPages("en", "Markdown");
    expect(results[0]?.path).toBe("/en/guide/markdown");
    // Both articles mention Markdown in their body, so this exercises ranking
    // rather than merely returning the only match.
    expect(results.some((result) => result.path === "/en/home")).toBe(true);
    expect(results.some((result) => result.path === "/en/guide/reading")).toBe(
      true,
    );
  });

  it("ranks a metadata tag match above body-only matches", () => {
    const results = searchPages("en", "code");
    expect(results[0]?.path).toBe("/en/guide/markdown");
    expect(results[0]?.tags).toContain("code");
    expect(results.length).toBeGreaterThan(1);
  });

  it.each(["zh", "en"] as const)(
    "keeps every result in the requested %s language",
    (language) => {
      const results = searchPages(language, "Markdown");
      expect(results.length).toBeGreaterThan(1);
      for (const result of results) {
        expect(result.path.startsWith(`/${language}/`)).toBe(true);
        const page = publishedPages.find(
          (entry) =>
            entry.language === language &&
            `/${language}/${entry.path}` === result.path,
        );
        expect(result.title).toBe(page?.title);
        expect(result.description).toBe(page?.description);
      }
    },
  );

  it("requires every query term while allowing matches across different fields", () => {
    expect(
      searchPages("en", "Markdown clipboard").map((result) => result.path),
    ).toEqual(["/en/guide/reading"]);
    // Markdown matches the title; code matches the tags and description.
    expect(searchPages("en", "Markdown code")[0]?.path).toBe(
      "/en/guide/markdown",
    );
    expect(searchPages("en", "Markdown definitely-not-in-the-catalog")).toEqual(
      [],
    );
  });

  it("normalizes Unicode width, letter case and full-width query whitespace", () => {
    expect(searchPages("en", "ＭＡＲＫＤＯＷＮ")).toEqual(
      searchPages("en", "markdown"),
    );
    expect(searchPages("zh", "Ｍａｒｋｄｏｗｎ　ｃｏｄｅ")).toEqual(
      searchPages("zh", "markdown code"),
    );
  });

  it("treats regex metacharacters as literal input without executing them", () => {
    expect(searchPages("en", ".*")).toEqual([]);
    expect(searchPages("en", "(a+)+$")).toEqual([]);
    // An unclosed bracket is still a valid literal search term. The expected
    // set comes from document text, not a regular-expression interpretation.
    const expected = publishedPages
      .filter(
        (page) =>
          page.language === "en" &&
          [
            page.title,
            page.description,
            page.path,
            page.tags.join(" "),
            page.markdown,
          ].some((field) => field.includes("[")),
      )
      .map((page) => `/en/${page.path}`)
      .sort();
    expect(
      searchPages("en", "[")
        .map((result) => result.path)
        .sort(),
    ).toEqual(expected);
  });

  it("does not interpret query operators, SQL or HTML as search commands", () => {
    for (const query of [
      '" OR 1=1 --',
      "title:Markdown",
      "<script>alert(1)</script>",
      "Markdown|guide",
    ])
      expect(searchPages("en", query)).toEqual([]);
    expect(searchPages("en", " \t\n ")).toEqual([]);
  });
});
