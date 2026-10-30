import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ImapFlow } from "imapflow";

/**
 * R57 full mailbox sync, end to end on the local server against the local Stalwart test server (never remote): a mailbox
 * of 620 messages, nearly all older than the first sync's 30 days, comes in whole through chained passes (Node chains them
 * on a timer here, MAIL_SYNC_CHAIN_MS; Workers on the Durable Object's alarm), the progress shows on the connection screen
 * and then "All mail synced", and opening the oldest message loads its body from the provider.
 * Run with MAIL_SYNC_CHAIN_MS=1000 MAIL_SYNC_BACKFILL_BATCH=60 and the STALWART_TEST_* variables.
 */
const PORT = process.env.E2E_IDP_PORT ?? "8790";
const BASE = `http://localhost:${PORT}`;
const live = !!process.env.STALWART_TEST_URL && !process.env.E2E_BASE_URL;
test.skip(!!process.env.E2E_BASE_URL, "local only: needs the faked identity provider");
const SHOTS = process.env.R57_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
test.use({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
const [imapHost, imapPort] = (process.env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
const [smtpHost, smtpPort] = (process.env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");
const TOTAL = 620;

async function signInFresh(page: Page, email: string, name: string) {
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), email, name })).toString("base64url");
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

function account(local: string) {
  return JSON.parse(execFileSync("npx", ["tsx", "e2e/support/stalwart-account.ts", local], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { user: string; pass: string };
}

/** 620 messages, oldest first: all but the last 5 dated two years ago. */
async function fill(user: string, pass: string) {
  const c = new ImapFlow({ host: imapHost, port: Number(imapPort), secure: false, doSTARTTLS: true, logger: false, auth: { user, pass }, tls: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const old = Date.now() - 730 * 86_400_000;
    for (let i = 1; i <= TOTAL; i++) {
      const recent = i > TOTAL - 5;
      const date = new Date(recent ? Date.now() - (TOTAL - i) * 60_000 : old + i * 3_600_000);
      const n = String(i).padStart(4, "0");
      const raw = [`From: Grace Hopper <grace@navy.example>`, `To: ${user}`, `Subject: Archive note ${n}`, `Message-ID: <r57.${n}.${Date.now()}@navy.example>`, `Date: ${date.toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", `Opening line of note ${n}.`, "", `The full body of note ${n} sits further down. `.repeat(200), `Closing words of note ${n}.`].join("\r\n");
      await c.append("INBOX", raw, i % 3 ? ["\\Seen"] : [], date);
    }
  } finally { await c.logout(); }
}

test("a 620 message mailbox syncs whole through chained passes, shows progress, and an old message loads its body", async ({ page }) => {
  test.skip(!live, "needs the local Stalwart test server (STALWART_TEST_URL)");
  test.setTimeout(240_000);
  const { user, pass } = account(`full${Date.now().toString(36)}`);
  await fill(user, pass);

  const stamp = Date.now().toString(36);
  await signInFresh(page, `full-${stamp}@example.com`, `Grace ${stamp}`);
  await expect(page.getByRole("heading", { name: "Welcome to Multies" })).toBeVisible();
  await page.getByLabel("Company or team").fill("Navy Computing");
  await page.getByRole("button", { name: "Continue" }).click();

  const made = await page.request.post(`${BASE}/api/connections`, { data: {
    email: user, password: pass, preset: "custom",
    imap: { host: imapHost, port: Number(imapPort), security: "starttls" }, smtp: { host: smtpHost, port: Number(smtpPort), security: "starttls" },
  } });
  expect(made.status()).toBe(201);
  const { connection } = (await made.json()) as { connection: { id: string; mailboxId: string; messagesSynced: number } };
  // The first pass: the recent 5, then the first batch of older mail. Far from all of it.
  expect(connection.messagesSynced).toBeLessThan(TOTAL);

  await page.goto(`${BASE}/app/settings/connections`);
  const progress = page.getByTestId("sync-progress-text").first();
  await expect(progress).toContainText(/Syncing your mailbox: [\d,]+ (of 620|so far) \(older mail keeps coming in\)/, { timeout: 20_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/full-sync-progress-desktop-light.png` });

  // No button presses: the passes chain by themselves until every message is in.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("sync-progress-text").first()).toHaveText("All mail synced", { timeout: 2_000 });
  }).toPass({ timeout: 180_000, intervals: [3_000] });
  const list = await page.request.get(`${BASE}/api/connections`);
  const conn = ((await list.json()) as { connections: { id: string; messagesSynced: number; backfill: { done: boolean; total: number } }[] }).connections.find((x) => x.id === connection.id)!;
  expect(conn.messagesSynced).toBe(TOTAL);
  expect(conn.backfill).toMatchObject({ done: true, total: TOTAL });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/full-sync-done-desktop-light.png` });

  // The oldest message was stored header and snippet only; opening it brings its body from the provider.
  await page.goto(`${BASE}/app/mail?mailbox=${connection.mailboxId}&q=${encodeURIComponent("Archive note 0001")}`);
  await page.getByText("Archive note 0001").first().click();
  await expect(page.getByText("Closing words of note 0001.").first()).toBeVisible({ timeout: 20_000 });

  // Phone 390: the Mail banner is gone once done, and the connection screen still reads well.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/app/settings/connections`);
  await expect(page.getByTestId("sync-progress-text").first()).toHaveText("All mail synced");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/full-sync-done-phone-light.png` });
});
