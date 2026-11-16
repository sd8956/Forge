// Evidence (screenshots, video, trace) goes to EVIDENCE_DIR so the e2e step can collect it.
import { defineConfig } from "@playwright/test";

const evidence = process.env.EVIDENCE_DIR ?? "test-results";
const port = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: "e2e",
  outputDir: `${evidence}/playwright`,
  reporter: [["list"], ["json", { outputFile: `${evidence}/results.json` }]],
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "on", video: "on", trace: "on" },
  webServer: { command: `make up PORT=${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30_000 },
});
