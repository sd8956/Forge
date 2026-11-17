import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: "backend", environment: "node", include: ["packages/backend/src/**/*.test.ts", "packages/backend/test/**/*.test.ts", "packages/shared/src/**/*.test.ts"] },
      },
      {
        extends: true,
        plugins: [react()],
        test: { name: "web", environment: "jsdom", include: ["packages/web/src/**/*.test.tsx", "packages/web/src/**/*.test.ts"] },
      },
    ],
  },
});
