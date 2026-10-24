import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8788" },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: "rm -rf .data/e2e.db .data/e2e-outbox && PORT=8788 DATABASE_PATH=.data/e2e.db OUTBOX_DIR=.data/e2e-outbox DEMO_MODE=true SCHEDULING_ENABLED=true APP_URL=http://localhost:8788 npx tsx src/entry/node.ts",
    url: "http://localhost:8788/api/health",
    reuseExistingServer: false,
  },
});
