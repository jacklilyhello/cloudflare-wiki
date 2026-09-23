import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../shared/auth";

// Initial form state is rendered without mounting Monaco or firing preview effects.
vi.mock("../src/admin/MarkdownCodeEditor", () => ({
  MarkdownCodeEditor: () => null,
}));
vi.mock("../src/admin/MarkdownPreview", () => ({
  MarkdownPreview: () => null,
}));

// Vite loads this browser module for the rendering test. Its CSS/Monaco types
// belong to tsconfig.app, rather than the workerd types used by this test suite.
const editorModule = "../src/admin/EditorPage";
const { EditorPage } = await import(editorModule);

const session: AuthSession = {
  user: { id: 1, username: "fixture-owner", version: 1 },
  csrfToken: "fictional-test-csrf",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T08:00:00.000Z",
  idleExpiresAt: "2026-01-01T00:30:00.000Z",
};
function render(search: string, translationId?: string) {
  vi.stubGlobal("window", { location: { search } });
  return renderToString(
    createElement(EditorPage, {
      language: "en",
      session,
      translationId,
      onExpired() {},
      onSessionChange() {},
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("directory-aware editor initial state", () => {
  it("prefills a decoded directory while retaining a clean draft baseline", () => {
    const html = render(
      "?prefix=%E6%95%99%E7%A8%8B%2Fsetup&language=en&pageId=seed%3Ahome",
    );
    expect(html).toContain('value="教程/setup/"');
    expect(html).toContain('class="wiki-save-state ">Saved</span>');
    expect(html).not.toContain("Unsaved changes");
    expect(html).toContain('<option value="en" selected="">');
  });

  it.each([
    "",
    "?prefix=",
    "?prefix=guide&prefix=guide",
    "?prefix=guide&%70refix=setup",
    "?prefix=Guide",
    "?prefix=guide%252Fsetup",
    "?prefix=guide%2F..%2Fadmin",
    "?prefix=guide%0A",
    "?prefix=search",
    "?prefix=guide%5Csetup",
    "?prefix=%E0%A4%A",
  ])("keeps missing or invalid prefix empty and clean: %s", (query) => {
    const html = render(query);
    expect(html).not.toContain('value="guide/"');
    expect(html).not.toContain("Unsaved changes");
    expect(
      html.match(/<input[^>]*placeholder="guide\/getting-started"[^>]*>/)?.[0],
    ).toContain('value=""');
  });

  it("ignores prefix while an existing translation loads", () => {
    const html = render("?prefix=guide&language=en", "seed:en:home");
    expect(html).not.toContain('value="guide/"');
    expect(html).not.toContain("Unsaved changes");
    expect(html).toContain("Opening document");
  });
});
