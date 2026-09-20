import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@eve/contracts": resolve("packages/contracts/src/index.ts"),
      "@eve/core": resolve("packages/core/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["tests/desktop/**"],
    environment: "node",
  },
});
