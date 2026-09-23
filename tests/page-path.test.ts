import { describe, expect, it } from "vitest";
import { isContentPath } from "../shared/page-path";
import { ContentError, validateContentPath } from "../worker/content/service";

describe("shared canonical content paths", () => {
  it.each([
    "guide/setup",
    "教程/快速开始",
    "guide_1/install-2",
    "école/été",
    "search-guide/admin",
    "文".repeat(240),
    "𠀀".repeat(120),
  ])("accepts an unchanged canonical path %s", (path) => {
    expect(isContentPath(path)).toBe(true);
    expect(validateContentPath(path)).toBe(path);
  });

  it.each([
    undefined,
    null,
    1,
    {},
    [],
    "",
    " ",
    "guide ",
    " guide",
    "guide\n",
    "guide\r\n",
    "Guide",
    "ｇｕｉｄｅ",
    "e\u0301cole",
    "/guide",
    "guide/",
    "guide//setup",
    "guide/../admin",
    "guide\\setup",
    "guide%2Fsetup",
    "guide?next=x",
    "guide#part",
    "https://example.com",
    "guide\u0000",
    "guide\u007f",
    "guide\u0085",
    "guide\ud800",
    "emoji/😀",
    "文".repeat(241),
    "𠀀".repeat(121),
    "robots.txt",
    "sitemap.xml",
    "admin/bad/",
  ])(
    "rejects invalid syntax without normalization or decoding, case %#",
    (value) => {
      expect(isContentPath(value)).toBe(false);
      try {
        validateContentPath(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ContentError);
        expect(error).toMatchObject({
          status: 400,
          message: "Invalid page path.",
        });
      }
    },
  );

  it.each(["search", "admin", "api", "assets", "health"])(
    "preserves reserved-root errors for %s and its descendants",
    (root) => {
      for (const path of [root, `${root}/guide`]) {
        expect(isContentPath(path)).toBe(false);
        expect(() => validateContentPath(path)).toThrow(
          "This page path is reserved.",
        );
      }
    },
  );
});
