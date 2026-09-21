import type { HealthResponse } from "../shared/contracts";
import { adminApi, adminShell } from "./admin";
import { publicSearch, renderReader, sitemap } from "./reader";
import { securityHeaders as headers } from "./security";

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
    if (pathname === "/api/public/search") return publicSearch(request, env);
    if (pathname === "/api/admin" || pathname.startsWith("/api/admin/"))
      return adminApi(request, env);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404, headers });
    }
    if (pathname === "/sitemap.xml") return sitemap(request, env);
    if (pathname === "/admin" || pathname.startsWith("/admin/"))
      return adminShell(request, env);
    // Asset paths stay on the asset service. Unknown document paths reach the
    // Worker for a real 404, never the old successful SPA fallback.
    if (
      pathname.startsWith("/assets/") ||
      pathname === "/robots.txt" ||
      pathname === "/favicon.svg"
    ) {
      return env.ASSETS.fetch(request);
    }
    return renderReader(request, env);
  },
} satisfies ExportedHandler<Env>;
