import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { monacoCsp } from "./scripts/monaco-csp.ts";

export default defineConfig({
  plugins: [monacoCsp(), react(), cloudflare({ inspectorPort: false })],
  optimizeDeps: { exclude: ["monaco-editor"] },
});
