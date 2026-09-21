import { describe, expect, it } from "vitest";
import {
  compileSearchQuery,
  indexSearchText,
  markdownText,
} from "../shared/search";

describe("search text and bounded MATCH compiler", () => {
  it("normalizes Unicode width and splits Han while keeping Latin words", () => {
    expect(indexSearchText("Ｅｍｂｙ　媒体服务器 HTTPS")).toBe(
      "emby 媒 体 服 务 器 https",
    );
    expect(compileSearchQuery("媒体服务器 ＨＴＴＰＳ")).toBe(
      '"媒 体 服 务 器" AND "https"',
    );
  });
  it("quotes all words so FTS operators cannot execute", () => {
    expect(compileSearchQuery('title:Markdown OR "server"* -NEAR(foo)')).toBe(
      '"title" AND "markdown" AND "or" AND "server" AND "near" AND "foo"',
    );
    expect(compileSearchQuery('" OR 1=1 --')).toBe('"or" AND "1" AND "1"');
    expect(compileSearchQuery("[] .* / ")).toBeNull();
    expect(compileSearchQuery("x".repeat(201))).toBeNull();
  });
  it("keeps Chinese phrases ordered instead of turning them into a bag of characters", () => {
    expect(compileSearchQuery("服务器")).toBe('"服 务 器"');
    expect(compileSearchQuery("器务服")).toBe('"器 务 服"');
    expect(compileSearchQuery("Emby服务器")).toBe('"emby 服 务 器"');
  });
  it("extracts readable Markdown text without exposing markup and URLs", () => {
    const text = markdownText(
      "# Title\n\n[[guide/reading|Read this]] and ~~old~~\n\n| A | B |\n|---|---|\n|[label](https://private.invalid)|value|\n\n![Screenshot](/image.png)\n\n<script>hidden()</script>",
    );
    expect(text).toBe("Title Read this and old A B label value Screenshot");
    expect(text).not.toContain("private.invalid");
    expect(text).not.toContain("hidden");
  });
  it("indexes visible semantic HTML text while removing executable elements", () => {
    expect(
      markdownText(
        "<details><summary>Setup</summary><p>Server guide</p><script>privateScript</script></details>",
      ),
    ).toBe("Setup Server guide");
  });
});
