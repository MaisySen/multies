import { defineConfig } from "@playwright/test";

// Ports can move (E2E_PORT, E2E_IDP_PORT) so two checkouts can run their suites side by side.
const PORT = process.env.E2E_PORT ?? "8788";
const IDP_PORT = process.env.E2E_IDP_PORT ?? "8790";

// The full suite signs up, opens demos and sends mail: thousands of D1 row writes a run. Against a
// deployed Multies it spends the daily write budget that production shares with staging (24 October
// 2026: staging runs and demos took about 69,000 rows and production went read only). So a remote
// E2E_BASE_URL needs E2E_ALLOW_REMOTE=1 and a --grep, never the whole suite. Confirm a deploy with
// one GET of /api/config instead (docs/runbooks/d1-daily-limits.md).
const remote = process.env.E2E_BASE_URL && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.E2E_BASE_URL);
if (remote) {
  const grep = process.argv.some((a) => a === "--grep" || a === "-g" || a.startsWith("--grep="));
  if (process.env.E2E_ALLOW_REMOTE !== "1" || !grep) {
    throw new Error(`Refusing to run E2E against ${process.env.E2E_BASE_URL}: it writes to a shared D1 database with a daily cap. Run locally, or set E2E_ALLOW_REMOTE=1 and pass --grep for one spec.`);
  }
}

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
      // Connected mailbox E2E reaches the local test mail server (self-signed, 127.0.0.1): allowed here only, never in production.
      command: `rm -rf .data/e2e-idp.db .data/e2e-idp-outbox && PORT=${IDP_PORT} DATABASE_PATH=.data/e2e-idp.db OUTBOX_DIR=.data/e2e-idp-outbox TRUST_PROXY=true MAIL_CONNECT_ALLOW_SELF_SIGNED=true MAIL_CONNECT_ALLOW_PRIVATE_HOSTS=true APP_URL=http://localhost:${IDP_PORT} npx tsx e2e/support/idp-server.ts`,
      url: `http://localhost:${IDP_PORT}/api/health`,
      reuseExistingServer: false,
    },
  ],
});
