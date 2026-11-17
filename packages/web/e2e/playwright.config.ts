import { defineConfig } from "@playwright/test";

// Black-box test of the panel: global-setup starts the real backend (`forge serve`) with the fake
// claude and fake gh on a copy of the demo fixture.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  outputDir: "../../../.forge-e2e/test-results",
  reporter: [["list"]],
  use: { screenshot: "only-on-failure", trace: "retain-on-failure", viewport: { width: 1440, height: 900 } },
});
