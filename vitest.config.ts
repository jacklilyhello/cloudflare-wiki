import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_ENV: "test",
          PUBLIC_ORIGIN: "https://cf.emby.wiki",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        assets: {
          directory: "tests/fixtures/assets",
          binding: "ASSETS",
          assetConfig: { html_handling: "none" },
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
}));
