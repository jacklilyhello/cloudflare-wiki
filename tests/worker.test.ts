import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker HTTP boundary", () => {
  it("serves uncached health JSON even for browser navigation", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      headers: { "Sec-Fetch-Mode": "navigate" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "cloudflare-wiki",
      environment: "test",
      revision: "local",
    });
  });
  it("supports bodyless HEAD health checks", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
  it("rejects mutations on the health endpoint", async () => {
    const response = await exports.default.fetch("https://example.com/health", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
  });
  it.each(["/api", "/api/missing", "/api/admin/pages"])(
    "returns JSON 404 for unimplemented %s",
    async (path) => {
      const response = await exports.default.fetch(
        `https://example.com${path}`,
        { headers: { "Sec-Fetch-Mode": "navigate" } },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    },
  );
});
