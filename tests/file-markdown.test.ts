import { describe, expect, it } from "vitest";
import {
  defaultFileLabel,
  fileMarkdown,
  isInsertableFile,
} from "../shared/file-markdown";
import type { FileEntry } from "../shared/files";
import { renderMarkdown } from "../shared/markdown";

const entry: FileEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "file",
  parentId: null,
  name: "diagram.png",
  version: 3,
  state: "ready",
  thumbnailState: "none",
  alt: { zh: "安装示意图", en: "Installation diagram" },
  source: { bytes: 100, mime: "image/png", width: 10, height: 10 },
  thumbnail: null,
  uploadExpiresAt: "2026-01-01T00:15:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function decodeRenderedText(text: string) {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

describe("file Markdown insertion", () => {
  it("uses article-language alt text and falls back to the file name", () => {
    expect(defaultFileLabel(entry, "zh")).toBe("安装示意图");
    expect(defaultFileLabel(entry, "en")).toBe("Installation diagram");
    expect(defaultFileLabel({ ...entry, alt: { zh: "", en: "" } }, "zh")).toBe(
      "diagram.png",
    );
  });

  it.each(["image", "download"] as const)(
    "round-trips hostile labels into exactly one %s with the canonical URL",
    async (kind) => {
      const label =
        '中文 ](https://evil.test) ![x](/bad) [[admin|x]] <img src=x onerror="x"> &NewLine; \\ `code` **bold** $x$ :name[test]';
      const { html } = await renderMarkdown(
        fileMarkdown(entry, label, kind),
        "en",
      );
      const url = `/files/${entry.id}/${kind}`;
      if (kind === "image") {
        const image = html.match(
          /^<p><img src="([^"]+)" alt="([^"]*)" loading="lazy" decoding="async"><\/p>$/,
        );
        expect(image?.[1]).toBe(url);
        expect(decodeRenderedText(image?.[2] ?? "")).toBe(label);
      } else {
        const link = html.match(/^<p><a href="([^"]+)">([^<]*)<\/a><\/p>$/);
        expect(link?.[1]).toBe(url);
        expect(decodeRenderedText(link?.[2] ?? "")).toBe(label);
      }
    },
  );

  it("normalizes controls and newlines without creating blocks or extra links", async () => {
    const source = fileMarkdown(
      entry,
      " first\r\n\n[x]\tlast\u2028line ",
      "download",
    );
    expect(source).not.toContain("\n");
    expect((await renderMarkdown(source, "en")).html).toBe(
      `<p><a href="/files/${entry.id}/download">first [x] last line</a></p>`,
    );
  });

  it("allows a download link for images and attachments, never an attachment image", async () => {
    const attachment = {
      ...entry,
      source: {
        bytes: 50,
        mime: "application/octet-stream" as const,
        width: null,
        height: null,
      },
    };
    expect(fileMarkdown(attachment, "Download", "download")).toContain(
      "/download)",
    );
    expect(() => fileMarkdown(attachment, "Download", "image")).toThrow();
    expect(fileMarkdown(entry, "Download", "download")).toContain("/download)");
  });

  it.each([
    { publishedAt: null },
    { deletedAt: "2026-01-01T00:00:00.000Z" },
    { state: "pending" as const },
    { state: "abandoned" as const },
    { kind: "folder" as const },
    { source: null },
    { id: "../api/admin/files/private" },
    { id: "https://evil.test/image" },
  ])("rejects inaccessible or noncanonical file metadata %j", (override) => {
    const invalid = { ...entry, ...override };
    expect(isInsertableFile(invalid)).toBe(false);
    expect(() => fileMarkdown(invalid, "Label", "download")).toThrow();
  });

  it("rejects empty or over-limit labels and unknown insertion modes", () => {
    for (const label of ["", "\n\t", "x".repeat(501)])
      expect(() => fileMarkdown(entry, label, "image")).toThrow();
    expect(() =>
      fileMarkdown(entry, "Label", "thumbnail" as "image"),
    ).toThrow();
  });
});
