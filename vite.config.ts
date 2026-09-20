import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "apps/desktop/renderer",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@eve/contracts": resolve("packages/contracts/src/index.ts") },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: "../../../dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
  },
});
