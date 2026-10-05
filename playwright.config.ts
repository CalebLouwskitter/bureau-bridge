import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 390, height: 844 },
    launchOptions: process.env.CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
      : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve-mobile-export.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
