import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ImapFlow } from "imapflow";

/**
 * Connect an existing mailbox, end to end on the local server against a real IMAP and SMTP server
 * (Stalwart on this box, self-signed, allowed by MAIL_CONNECT_ALLOW_SELF_SIGNED on the local E2E
 * server only): onboarding connects it, the inbox shows its mail, a reply goes out through the
 * mailbox's own SMTP and lands in its Sent folder, and Settings, Connected accounts shows status,
 * Sync now, Reconnect and Remove. Skipped without the STALWART_TEST_* variables. Never remote.
 */
const PORT = process.env.E2E_IDP_PORT ?? "8790";
const BASE = `http://localhost:${PORT}`;
const live = !!process.env.STALWART_TEST_URL && !process.env.E2E_BASE_URL;
test.skip(!!process.env.E2E_BASE_URL, "local only: needs the faked identity provider");
const SHOTS = process.env.R18_SHOTS;
// Its own client address, so sign in limits (per IP) don't collide with specs running alongside.
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
test.use({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const [imapHost, imapPort] = (process.env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
const [smtpHost, smtpPort] = (process.env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");

/** Signs a brand new person in through the faked identity provider (as in e2e/free-address.spec.ts). */
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

async function withImap<T>(user: string, pass: string, fn: (c: ImapFlow) => Promise<T>) {
  // Semgrep (QUAL1): the local test mail server's self signed certificate (e2e only).
  const c = new ImapFlow({ host: imapHost, port: Number(imapPort), secure: false, doSTARTTLS: true, logger: false, auth: { user, pass }, tls: { rejectUnauthorized: false } }); // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
  await c.connect();
  try { return await fn(c); } finally { await c.logout(); }
}

async function subjects(user: string, pass: string, special: "INBOX" | "\\Sent") {
  return withImap(user, pass, async (c) => {
    const path = special === "INBOX" ? "INBOX" : (await c.list()).find((f) => f.specialUse === "\\Sent")!.path;
    const lock = await c.getMailboxLock(path);
    const out: string[] = [];
    try { for await (const m of c.fetch("1:*", { envelope: true })) out.push(m.envelope?.subject ?? ""); } catch { /* empty */ } finally { lock.release(); }
    return out;
  });
}

async function appendTo(user: string, pass: string, subject: string) {
  await withImap(user, pass, (c) => c.append("INBOX", [`From: Grace Hopper <grace@navy.example>`, `To: ${user}`, `Subject: ${subject}`, `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@navy.example>`, `Date: ${new Date().toUTCString()}`, "", "Hello from the provider."].join("\r\n")));
}

test("connect a mailbox from onboarding, read its mail, reply as that address, manage it in Settings", async ({ page }) => {
  test.skip(!live, "needs the local Stalwart test server (STALWART_TEST_URL)");
  test.setTimeout(120_000);
  const { user, pass } = account(`ada${Date.now().toString(36)}`);
  await appendTo(user, pass, "Quarterly numbers");
  await appendTo(user, pass, "Lunch on Friday?");

  const stamp = Date.now().toString(36);
  await signInFresh(page, `connect-${stamp}@example.com`, `Ada ${stamp}`);
  await expect(page.getByRole("heading", { name: "Welcome to Multies" })).toBeVisible();
  await page.getByLabel("Company or team").fill("Analytical Engines");
  await page.getByRole("button", { name: "Continue" }).click();

  // The connect path is live, not "coming soon".
  const card = page.getByTestId("path-connect");
  await expect(card).not.toContainText("Coming soon");
  await card.getByTestId("path-connect-open").click();
  const form = card.getByTestId("connect-form");
  await form.getByTestId("connect-email").fill("someone@gmail.com");
  await expect(form.getByTestId("connect-provider")).toHaveValue("gmail");
  await expect(form.getByTestId("connect-help")).toContainText("app password");
  await expect(form.getByRole("link", { name: "Make an app password" })).toHaveAttribute("href", "https://myaccount.google.com/apppasswords");
  if (SHOTS) await card.screenshot({ path: `${SHOTS}/1b-connect-gmail.png` });

  // Any other server: the real test server on this box.
  await form.getByTestId("connect-email").fill(user);
  await form.getByTestId("connect-provider").selectOption("custom");
  await form.getByTestId("imap-host").fill(imapHost);
  await form.getByTestId("imap-port").fill(imapPort);
  await form.getByTestId("imap-security").selectOption("starttls");
  await form.getByTestId("smtp-host").fill(smtpHost);
  await form.getByTestId("smtp-port").fill(smtpPort);
  await form.getByTestId("smtp-security").selectOption("starttls");

  // A wrong password is explained, and nothing is saved.
  await form.getByTestId("connect-password").fill("not-the-app-password");
  await form.getByTestId("connect-test").click();
  await expect(form.getByTestId("connect-result")).toContainText("didn't accept that address and password");

  await form.getByTestId("connect-password").fill(pass);
  await form.getByTestId("connect-test").click();
  await expect(form.getByTestId("connect-result")).toContainText("Both servers accepted the password");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-connect-screen.png`, fullPage: true });
  await form.getByTestId("connect-submit").click();
  await expect(card.getByTestId("connect-done")).toContainText(`${user} is connected`, { timeout: 20_000 });

  // The inbox shows the provider's mail.
  await card.getByRole("link", { name: "Open inbox" }).click();
  await expect(page.getByText("Quarterly numbers").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Lunch on Friday?").first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-synced-inbox.png`, fullPage: true });

  // Send as that address: through its own SMTP, filed in its own Sent folder.
  await page.goto(`${BASE}/app/mail?compose=1`);
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const out = `Sent through my own provider ${stamp}`;
  await compose.getByLabel("To").fill(user);
  await compose.getByLabel("Subject").fill(out);
  await compose.getByLabel("Message").fill("Hello from Multies, as myself.");
  await compose.getByRole("button", { name: "Send" }).click();
  await expect(compose).toBeHidden();
  await page.getByTestId("undo-send-toast").getByRole("button", { name: "Send now" }).click();
  await expect.poll(() => subjects(user, pass, "INBOX"), { timeout: 30_000 }).toContain(out);
  await expect.poll(() => subjects(user, pass, "\\Sent"), { timeout: 15_000 }).toContain(out);

  // New mail at the provider comes in with Sync now.
  await appendTo(user, pass, `Arrived later ${stamp}`);
  await page.goto(`${BASE}/app/settings/connections`);
  const row = page.getByTestId("connection-row");
  await expect(row.getByTestId("connection-email")).toHaveText(user);
  await expect(row).toContainText("Connected");
  await expect(row).toContainText("last sync");
  await row.getByRole("button", { name: `Sync now ${user}` }).click();
  // Live mail (round 19) may already have copied it while the mail view was open: then Sync now is "Up to date".
  await expect(page.getByText(/new message|Up to date/).first()).toBeVisible({ timeout: 15_000 });
  // Two from before, one that arrived later; the copy of our own send is the same message (same Message-ID) and is not stored twice.
  await expect(row).toContainText("3 messages");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-connected-accounts.png`, fullPage: true });
  await page.goto(`${BASE}/app/mail`);
  await expect(page.getByText(`Arrived later ${stamp}`).first()).toBeVisible({ timeout: 15_000 });

  // Reconnect checks the new password first.
  await page.goto(`${BASE}/app/settings/connections`);
  await row.getByRole("button", { name: "Reconnect" }).click();
  await page.getByTestId("reconnect-password").fill("wrong-password-123");
  await page.getByTestId("reconnect-save").click();
  await expect(page.getByRole("alert").filter({ hasText: "didn't accept" })).toBeVisible();
  await page.getByTestId("reconnect-password").fill(pass);
  await page.getByTestId("reconnect-save").click();
  await expect(page.getByText(`${user} is reconnected`)).toBeVisible();

  // Remove: gone from Multies, still at the provider.
  await row.getByRole("button", { name: `Remove ${user}` }).click();
  await page.getByTestId("remove-confirm").click();
  await expect(page.getByTestId("connection-row")).toHaveCount(0);
  const list = await page.evaluate(async () => (await fetch("/api/connections")).json());
  expect(list.connections).toHaveLength(0);
  expect(await subjects(user, pass, "INBOX")).toContain("Quarterly numbers");
});

test.describe("on a phone, as in the apps' in-app browser", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });

  test("the connect form and the free address both fit and work at phone width", async ({ page }) => {
    const stamp = Date.now().toString(36);
    await signInFresh(page, `phone-${stamp}@example.com`, `Pat ${stamp}`);
    await page.getByLabel("Company or team").fill("Pat Studio");
    await page.getByRole("button", { name: "Continue" }).click();
    const card = page.getByTestId("path-connect");
    await card.getByTestId("path-connect-open").click();
    await card.getByTestId("connect-email").fill("pat@yahoo.com");
    await expect(card.getByTestId("connect-provider")).toHaveValue("yahoo");
    await expect(card.getByRole("link", { name: "Make an app password" })).toHaveAttribute("href", "https://login.yahoo.com/account/security");
    // Nothing runs off the side of a phone screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-phone-connect.png`, fullPage: true });
    // The free address still works from the same screen at phone width.
    const free = page.getByTestId("free-address");
    await free.getByLabel("Address").fill(`pat.${stamp}`);
    await free.getByRole("button", { name: "Get my address" }).click();
    await expect(page.getByTestId("free-address-value")).toHaveText(`pat.${stamp}@free.multies.test`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/5-phone-free-address.png`, fullPage: true });
  });
});
