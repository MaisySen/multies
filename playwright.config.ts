import { defineConfig } from "@playwright/test";

// Ports can move (E2E_PORT, E2E_IDP_PORT) so two checkouts can run their suites side by side.
const PORT = process.env.E2E_PORT ?? "8788";
const IDP_PORT = process.env.E2E_IDP_PORT ?? "8790";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}` },
  webServer: process.env.E2E_BASE_URL ? undefined : [
    {
      command: `rm -rf .data/e2e.db .data/e2e-outbox && PORT=${PORT} DATABASE_PATH=.data/e2e.db OUTBOX_DIR=.data/e2e-outbox DEMO_MODE=true SCHEDULING_ENABLED=true TRUST_PROXY=true APP_URL=http://localhost:${PORT} npx tsx src/entry/node.ts`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
    },
    {
      // The same app with the identity provider on, its endpoints faked in process (e2e/auth-idp.spec.ts).
      command: `rm -rf .data/e2e-idp.db .data/e2e-idp-outbox && PORT=${IDP_PORT} DATABASE_PATH=.data/e2e-idp.db OUTBOX_DIR=.data/e2e-idp-outbox TRUST_PROXY=true APP_URL=http://localhost:${IDP_PORT} npx tsx e2e/support/idp-server.ts`,
      url: `http://localhost:${IDP_PORT}/api/health`,
      reuseExistingServer: false,
    },
  ],
});
