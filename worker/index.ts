import type { HealthResponse } from "../shared/contracts";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { ...headers, Allow: "GET, HEAD" } },
        );
      }
      const health: HealthResponse = {
        status: "ok",
        service: "cloudflare-wiki",
        environment: "test",
        revision: env.BUILD_SHA,
      };
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify(health),
        {
          headers: {
            ...headers,
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404, headers });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
