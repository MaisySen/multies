import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { connectCode } from "./support/connect-code"; // PRIV1b (P60)

/**
 * Round 19, end to end on the local server against the local Stalwart test server (never remote):
 * live mail (new mail shows up in the open inbox without a reload, with the delay measured) and
 * folders beyond Inbox and Sent (the provider's own folders listed and synced on demand, and moves
 * both ways). Skipped without the STALWART_TEST_* variables.
 */
const PORT = process.env.E2E_IDP_PORT ?? "8790";
const BASE = `http://localhost:${PORT}`;
const live = !!process.env.STALWART_TEST_URL && !process.env.E2E_BASE_URL;
test.skip(!!process.env.E2E_BASE_URL, "local only: needs the faked identity provider");
const SHOTS = process.env.R19_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
test.use({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
const [imapHost, imapPort] = (process.env.STALWART_TEST_IMAP ?? "127.0.0.1:1143").split(":");
const [smtpHost, smtpPort] = (process.env.STALWART_TEST_SMTP ?? "127.0.0.1:1587").split(":");

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

const raw = (user: string, subject: string) => [`From: Grace Hopper <grace@navy.example>`, `To: ${user}`, `Subject: ${subject}`, `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@navy.example>`, `Date: ${new Date().toUTCString()}`, "", "Hello from the provider."].join("\r\n");

async function subjectsIn(user: string, pass: string, path: string) {
  return withImap(user, pass, async (c) => {
    const lock = await c.getMailboxLock(path);
    const out: string[] = [];
    try { for await (const m of c.fetch("1:*", { envelope: true })) out.push(m.envelope?.subject ?? ""); } catch { /* empty */ } finally { lock.release(); }
    return out;
  });
}

test("live mail and folders on a connected mailbox", async ({ page }) => {
  test.skip(!live, "needs the local Stalwart test server (STALWART_TEST_URL)");
  test.setTimeout(150_000);
  const { user, pass } = account(`live${Date.now().toString(36)}`);
  await withImap(user, pass, async (c) => {
    await c.append("INBOX", raw(user, "Already here"));
    await c.mailboxCreate("Clients");
    await c.append("Clients", raw(user, "Client contract"));
  });

  const stamp = Date.now().toString(36);
  await signInFresh(page, `live-${stamp}@example.com`, `Lin ${stamp}`);
  await page.getByLabel("Company or team").fill("Live Co");
  await page.getByRole("button", { name: "Continue" }).click();
  const made = await page.evaluate(async (body) => {
    const r = await fetch("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  }, { email: user, password: pass, preset: "custom", imap: { host: imapHost, port: Number(imapPort), security: "starttls" }, smtp: { host: smtpHost, port: Number(smtpPort), security: "starttls" } });
  expect(made.status).toBe(201);
  const connectionId = made.json.connection.id as string;
  // PRIV1b (P60): an unrecognised server waits for the code emailed to the address.
  const code = await connectCode(user);
  expect(await page.evaluate(async ([id, c]) => (await fetch(`/api/connections/${id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) })).status, [connectionId, code] as const)).toBe(200);
  const mailboxId = made.json.connection.mailboxId as string;

  // 1. Live mail: the open inbox shows new mail without a reload.
  const beats: boolean[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/connections/live")) beats.push(JSON.parse(r.postData() ?? "{}").poke === true); });
  if (process.env.R19_DEBUG) page.on("response", async (r) => { if (r.url().endsWith("/api/connections/live")) console.log("beat", new Date().toISOString(), r.request().postData(), r.status(), (await r.text()).slice(0, 200)); });
  await page.goto(`${BASE}/app/mail?mailbox=${mailboxId}`);
  await expect(page.getByText("Already here").first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => beats.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(beats[0]).toBe(true);
  const status = await page.evaluate(async () => (await (await fetch("/api/connections/live", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()));
  expect(status.live).toBe(true);
  await page.waitForTimeout(1500);
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    const subject = `Just arrived ${i} ${stamp}`;
    const t0 = Date.now();
    await withImap(user, pass, (c) => c.append("INBOX", raw(user, subject)));
    await expect(page.getByText(subject).first()).toBeVisible({ timeout: 20_000 });
    delays.push(Date.now() - t0);
  }
  const sorted = [...delays].sort((a, b) => a - b);
  const report = { what: "provider accepted message -> visible in the open Multies inbox, no reload", delaysMs: delays, medianMs: sorted[1], maxMs: sorted[2], heartbeat: "long poll, up to 25 s, answered when mail is stored" };
  console.log("live mail UI delay", JSON.stringify(report));
  if (SHOTS) writeFileSync(`${SHOTS}/live-mail-ui-delay.json`, JSON.stringify(report, null, 2));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-live-mail-arrived.png`, fullPage: true });
  expect(report.maxMs).toBeLessThan(5_000);

  // 2. Folders: the provider's own folders, synced on demand.
  const nav = page.getByTestId("provider-folders");
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "Choose folders to sync" }).click();
  const chooser = page.getByTestId("provider-folder-chooser");
  await expect(chooser.getByLabel("Clients")).not.toBeChecked();
  await chooser.getByLabel("Clients").check();
  await expect(nav.getByRole("button", { name: "Clients" })).toBeVisible({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-provider-folders.png`, fullPage: true });
  await nav.getByRole("button", { name: "Clients" }).click();
  await expect(page.getByText("Client contract").first()).toBeVisible({ timeout: 15_000 });

  // 3. Move from Multies to a provider folder: it lands there at the provider.
  await page.goto(`${BASE}/app/mail?mailbox=${mailboxId}`);
  await page.getByText("Already here").first().click();
  const moveTo = page.getByTestId("move-to");
  await expect(moveTo).toBeAttached({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-move-to.png`, fullPage: true });
  await moveTo.selectOption({ label: "Clients" });
  await expect.poll(() => subjectsIn(user, pass, "Clients"), { timeout: 20_000 }).toContain("Already here");
  expect(await subjectsIn(user, pass, "INBOX")).not.toContain("Already here");
  await page.goto(`${BASE}/app/mail?mailbox=${mailboxId}&folder=${encodeURIComponent("f:Clients")}`);
  await expect(page.getByText("Already here").first()).toBeVisible({ timeout: 15_000 });

  // 4. Move at the provider (as in another mail app): Multies follows on its next pass.
  await withImap(user, pass, async (c) => {
    const lock = await c.getMailboxLock("Clients");
    try {
      const uids = await c.search({ header: { subject: "Client contract" } }, { uid: true });
      await c.messageMove(uids as number[], "INBOX", { uid: true });
    } finally { lock.release(); }
  });
  const synced = await page.evaluate(async (id) => (await (await fetch(`/api/connections/${id}/sync`, { method: "POST" })).json()), connectionId);
  expect(synced.result.error).toBeNull();
  await page.goto(`${BASE}/app/mail?mailbox=${mailboxId}`);
  await expect(page.getByText("Client contract").first()).toBeVisible({ timeout: 15_000 });
  const list = await page.evaluate(async (mb) => (await (await fetch(`/api/mail/messages?mailboxId=${mb}&remote=${encodeURIComponent("f:Clients")}`)).json()), mailboxId);
  expect(list.messages.map((m: { subject: string }) => m.subject)).toEqual(["Already here"]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-moved-at-provider.png`, fullPage: true });
});
