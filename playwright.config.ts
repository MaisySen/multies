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

/**
 * The app server for E2E. W4: a second one (E2E_TD1_PORT, default 8792) runs with ASK_TD1 on for the specs that need
 * the workspace AI switch (TD1_SPECS), so they run in the normal suite; it keeps its own database and shares the outbox.
 */
function appCommand(o: { reset: string; port: string; db: string; td1: string }) {
  return `${o.reset}PORT=${o.port} DATABASE_PATH=.data/${o.db}.db OUTBOX_DIR=.data/e2e-outbox DEMO_MODE=true BILL_TD4=${process.env.E2E_BILL_TD4 ?? "on"} TOURS_R130=${process.env.TOURS_R130 ?? "on"} AI_CONNECT_AI2=${process.env.E2E_AI2 ?? "on"} OPENROUTER_AUTH_URL=https://openrouter.mock/auth MOBILE_WEB_LINK=on VAULT_R128=on PEOPLE_R126=${process.env.E2E_PEOPLE_R126 ?? "on"} TEAMAI_TD8=${process.env.E2E_TEAMAI_TD8 ?? "on"} INBOX_TD6=${process.env.E2E_INBOX_TD6 ?? "on"} MENTIONS_TD5=${process.env.E2E_MENTIONS_TD5 ?? "on"} REPORTING_R112=on POLISH_POL1=${process.env.E2E_POLISH_POL1 ?? "on"} NAV_P2_R121=${process.env.E2E_NAV_P2 ?? "on"} OFFICE_EDIT_R113=on FILES_PLUS_R101=${process.env.E2E_FILES_PLUS ?? "on"} MAIL_ARCHIVE_R111=${process.env.E2E_MAIL_ARCHIVE ?? "on"} HOME_WIDGETS_R131=on MEET_TD3=${process.env.MEET_TD3 ?? "on"} SOCIAL_P3_R132=on SOCIAL_MULTI_SOC1=${process.env.E2E_SOC1 ?? "off"} ${process.env.MOCK_FB_PAGES ? `MOCK_FB_PAGES=${process.env.MOCK_FB_PAGES} ` : ""}COURSES_R129=on SCHEDULING_ENABLED=true BOOKING_PLUS=${process.env.E2E_BOOKING_PLUS ?? "true"} FORMS_PLUS_R93=${process.env.E2E_FORMS_PLUS ?? "true"} FORMS_TD2=${process.env.FORMS_TD2 ?? "on"} FORMS_TD7=${process.env.E2E_FORMS_TD7 ?? "on"} SHIELD_DIFFICULTY=4 INVOICES_ENABLED=true TABLES_R125=on SITES_R123=on BLOG_R124=on EXPENSES_R106=on EXPENSES_FAKE_READ=1 CRM_TIMELINE=on DASHBOARDS_PLUS=test SEARCH_R98=${process.env.E2E_SEARCH_R98 ?? "on"} TRUST_PROXY=true E2E_LOCAL_RATE_KEYS=1 AI_FAKE=1 IMPORT_FILES=memory CALLS_TEST_HOOK=true CHANNELS_MOCK=on CHAT_CHANNELS=${process.env.E2E_CHAT_CHANNELS ?? "on"} HELP_CENTER=on TASKS_PLUS_R95=on CONTRACTS_R108=on WEBINAR_R114=on MAPS_R115=on MAPS_GEO_MOCK=1 ASK_R110=on ASK_TD1=${o.td1} ASK_AI_FAKE=1 DOCS_PLUS_R103=on DOCS_PLUS_FAKE_WEB=1 DAV_SYNC_R99=on COMPOSIO_API_KEY=mock COMPOSIO_BASE_URL=https://composio.mock TIKTOK_CLIENT_KEY=mock-key TIKTOK_CLIENT_SECRET=mock-secret TIKTOK_API_BASE=https://tiktok.mock TIKTOK_AUTH_URL=https://tiktok.mock/auth THREADS_APP_ID=mock-app THREADS_APP_SECRET=mock-secret THREADS_API_BASE=https://threads.mock THREADS_AUTH_URL=https://threads.mock/auth ${process.env.E2E_SOCIAL_TEST ? "SOCIAL_TEST_NETWORK=on " : ""}APP_URL=http://localhost:${o.port} PLATFORM_ADMIN_EMAILS=ops-r35@example.com npx tsx src/entry/node.ts`;
}
const TD1_PORT = process.env.E2E_TD1_PORT ?? "8792";
const TD1_SPECS = /polish-pol2\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}` },
  projects: [
    { name: "e2e", testIgnore: TD1_SPECS },
    { name: "td1", testMatch: TD1_SPECS, use: { baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${TD1_PORT}` } },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : [
    {
      // QUAL1: maps are on (MAPS_R115) with the offline address list (MAPS_GEO_MOCK), so the map specs run in CI. W4: Files plus
      // (FILES_PLUS_R101) and mail archive (MAIL_ARCHIVE_R111) are on too: the Files page, the R101 drive and archive specs and the
      // office editor from Files need them (E2E_FILES_PLUS=off, E2E_MAIL_ARCHIVE=off to compare).
      command: appCommand({ reset: "rm -rf .data/e2e.db .data/e2e-index.db* .data/e2e-outbox && ", port: PORT, db: "e2e", td1: process.env.E2E_TD1 ?? "off" }),
      url: `http://localhost:${PORT}/api/health`,
      env: { ...(process.env as Record<string, string>), ...e2eVapid() },
      reuseExistingServer: false,
    },
    {
      // W4: the same app with ASK_TD1 on (the workspace AI switch), for TD1_SPECS.
      command: appCommand({ reset: "rm -rf .data/e2e-td1.db .data/e2e-td1-index.db* && ", port: TD1_PORT, db: "e2e-td1", td1: "on" }),
      url: `http://localhost:${TD1_PORT}/api/health`,
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
