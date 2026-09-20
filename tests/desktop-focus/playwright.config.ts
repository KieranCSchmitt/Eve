import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  reporter: "line",
  outputDir: "../../test-results/desktop-focus",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: process.env.EVE_TEST_CHROMIUM_PATH
      ? { executablePath: process.env.EVE_TEST_CHROMIUM_PATH }
      : {},
  },
});
