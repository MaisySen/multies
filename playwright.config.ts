import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8788" },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: "rm -f .data/e2e.db && PORT=8788 DATABASE_PATH=.data/e2e.db npx tsx src/entry/node.ts",
    url: "http://localhost:8788/api/health",
    reuseExistingServer: false,
  },
});
