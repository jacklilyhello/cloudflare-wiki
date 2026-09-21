import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        assets: {
          directory: "tests/fixtures/assets",
          binding: "ASSETS",
          assetConfig: { html_handling: "none" },
        },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"] },
});
