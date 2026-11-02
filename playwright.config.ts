import { defineConfig } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";

// Ports can move (E2E_PORT, E2E_IDP_PORT) so two checkouts can run their suites side by side.
const PORT = process.env.E2E_PORT ?? "8788";
const IDP_PORT = process.env.E2E_IDP_PORT ?? "8790";

// The full suite signs up, opens demos and sends mail: thousands of D1 row writes a run. Against a
// deployed Multies it spends the daily write budget that production shares with staging (24 October
// 2026: staging runs and demos took about 69,000 rows and production went read only). So a remote
// E2E_BASE_URL needs E2E_ALLOW_REMOTE=1 and a --grep, never the whole suite. Confirm a deploy with
// one GET of /api/config instead (docs/runbooks/d1-daily-limits.md).
const remote = process.env.E2E_BASE_URL && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.E2E_BASE_URL);
// Playwright loads this file again in each worker, without the CLI flags; the runner already checked.
if (remote && !process.env.TEST_WORKER_INDEX) {
  const grep = process.argv.some((a) => a === "--grep" || a === "-g" || a.startsWith("--grep="));
  if (process.env.E2E_ALLOW_REMOTE !== "1" || !grep) {
    throw new Error(`Refusing to run E2E against ${process.env.E2E_BASE_URL}: it writes to a shared D1 database with a daily cap. Run locally, or set E2E_ALLOW_REMOTE=1 and pass --grep for one spec.`);
  }
}

// R32: a throwaway VAPID pair for each local run, so browser notifications are switched on in E2E without a
// key in the repo or on a command line. It signs nothing that leaves this machine.
function e2eVapid(): Record<string, string> {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: jwk.d!, VAPID_SUBJECT: "mailto:security@multies.si" };
}

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}` },
  webServer: process.env.E2E_BASE_URL ? undefined : [
    {
      command: `rm -rf .data/e2e.db .data/e2e-index.db* .data/e2e-outbox && PORT=${PORT} DATABASE_PATH=.data/e2e.db OUTBOX_DIR=.data/e2e-outbox DEMO_MODE=true MOBILE_WEB_LINK=on VAULT_R128=on PEOPLE_R126=${process.env.E2E_PEOPLE_R126 ?? "on"} REPORTING_R112=on POLISH_POL1=${process.env.E2E_POLISH_POL1 ?? "on"} NAV_P2_R121=${process.env.E2E_NAV_P2 ?? "on"} OFFICE_EDIT_R113=on HOME_WIDGETS_R131=on SOCIAL_P3_R132=on COURSES_R129=on SCHEDULING_ENABLED=true BOOKING_PLUS=${process.env.E2E_BOOKING_PLUS ?? "true"} FORMS_PLUS_R93=${process.env.E2E_FORMS_PLUS ?? "true"} FORMS_TD2=${process.env.FORMS_TD2 ?? "on"} SHIELD_DIFFICULTY=4 INVOICES_ENABLED=true TABLES_R125=on SITES_R123=on BLOG_R124=on EXPENSES_R106=on EXPENSES_FAKE_READ=1 CRM_TIMELINE=on DASHBOARDS_PLUS=test SEARCH_R98=${process.env.E2E_SEARCH_R98 ?? "on"} TRUST_PROXY=true E2E_LOCAL_RATE_KEYS=1 AI_FAKE=1 IMPORT_FILES=memory CALLS_TEST_HOOK=true CHANNELS_MOCK=on CHAT_CHANNELS=${process.env.E2E_CHAT_CHANNELS ?? "on"} HELP_CENTER=on TASKS_PLUS_R95=on CONTRACTS_R108=on WEBINAR_R114=on ASK_R110=on ASK_TD1=${process.env.E2E_TD1 ?? "off"} ASK_AI_FAKE=1 DOCS_PLUS_R103=on DOCS_PLUS_FAKE_WEB=1 DAV_SYNC_R99=on COMPOSIO_API_KEY=mock COMPOSIO_BASE_URL=https://composio.mock TIKTOK_CLIENT_KEY=mock-key TIKTOK_CLIENT_SECRET=mock-secret TIKTOK_API_BASE=https://tiktok.mock TIKTOK_AUTH_URL=https://tiktok.mock/auth THREADS_APP_ID=mock-app THREADS_APP_SECRET=mock-secret THREADS_API_BASE=https://threads.mock THREADS_AUTH_URL=https://threads.mock/auth ${process.env.E2E_SOCIAL_TEST ? "SOCIAL_TEST_NETWORK=on " : ""}APP_URL=http://localhost:${PORT} PLATFORM_ADMIN_EMAILS=ops-r35@example.com npx tsx src/entry/node.ts`,
      url: `http://localhost:${PORT}/api/health`,
      env: { ...(process.env as Record<string, string>), ...e2eVapid() },
      reuseExistingServer: false,
    },
    {
      // The same app with the identity provider on, its endpoints faked in process (e2e/auth-idp.spec.ts).
      // Connected mailbox E2E reaches the local test mail server (self-signed, 127.0.0.1): allowed here only, never in production.
      command: `rm -rf .data/e2e-idp.db .data/e2e-idp-index.db* .data/e2e-idp-outbox && PORT=${IDP_PORT} DATABASE_PATH=.data/e2e-idp.db OUTBOX_DIR=.data/e2e-idp-outbox TRUST_PROXY=true E2E_LOCAL_RATE_KEYS=1 MAIL_CONNECT_ALLOW_SELF_SIGNED=true MAIL_CONNECT_ALLOW_PRIVATE_HOSTS=true APP_URL=http://localhost:${IDP_PORT} npx tsx e2e/support/idp-server.ts`,
      url: `http://localhost:${IDP_PORT}/api/health`,
      reuseExistingServer: false,
    },
  ],
});
