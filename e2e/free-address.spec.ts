import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deliver } from "../email-worker/src/index";

/**
 * Free addresses, end to end on a local server with the identity provider faked in process
 * (e2e/support/idp-server.ts, shared domain free.multies.test): a brand new person signs in,
 * takes name.team@free.multies.test with one click, sends to the outside world (the local
 * outbox) and receives through the real Email Worker code. Local only.
 */
const PORT = process.env.E2E_IDP_PORT ?? "8790";
const BASE = `http://localhost:${PORT}`;
const OUTBOX = ".data/e2e-idp-outbox";
const KEY_FILE = ".data/e2e-idp.db.platform-key.json";
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");

export async function signInFresh(page: Page, email: string, name: string) {
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), email, name })).toString("base64url");
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

function outboxTo(address: string) {
  if (!existsSync(OUTBOX)) return undefined;
  for (const f of readdirSync(OUTBOX).sort().reverse()) {
    const m = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string[]; subject: string; from: { address: string } };
    if (m.to.includes(address)) return m;
  }
  return undefined;
}

export async function receive(to: string, subject: string) {
  const key = JSON.parse(readFileSync(KEY_FILE, "utf8")) as { id: string; secret: string };
  const raw = [`From: Grace Hopper <grace@navy.example>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${Date.now()}@navy.example>`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Welcome to your free address."].join("\r\n");
  let rejected: string | null = null;
  await deliver({ from: "grace@navy.example", to, rawSize: raw.length, raw: new Response(raw).body!, setReject: (r: string) => { rejected = r; }, forward: async () => {} },
    { MYMAIL_WEBHOOK_URL: `${BASE}/api/inbound/cloudflare`, MYMAIL_KEY_ID: key.id, MYMAIL_KEY_SECRET: key.secret });
  return rejected;
}

test("a new person with no domain takes a free address, sends out and receives", async ({ page }) => {
  const stamp = Date.now().toString(36);
  await signInFresh(page, `free-${stamp}@example.com`, `Fern ${stamp}`);
  // Onboarding first, when the workspace is new: finish it with what the browser already filled in.
  const onboarding = page.getByRole("heading", { name: "Welcome to Multies" });
  if (await onboarding.isVisible().catch(() => false)) await page.getByRole("button", { name: /Continue|Save and continue/ }).click();

  await page.goto(`${BASE}/app/mailboxes`);
  const card = page.getByTestId("free-address");
  await expect(card).toBeVisible();
  const input = card.getByLabel("Address");
  await expect(input).toHaveValue(/^fern/);
  await input.fill(`fern.${stamp}`);
  await card.getByRole("button", { name: "Get my address" }).click();
  const address = `fern.${stamp}@free.multies.test`;
  await expect(page.getByTestId("free-address-value")).toHaveText(address);

  // Send to the outside world from the new address.
  await page.goto(`${BASE}/app/mail?compose=1`);
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const subject = `Free address out ${stamp}`;
  await compose.getByLabel("To").fill("friend@outside.example");
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Sent from a free Multies address.");
  await compose.getByRole("button", { name: "Send" }).click();
  await expect(compose).toBeHidden();
  // Undo send holds the message for a few seconds; send it now instead of waiting (or leaving the page, which asks first).
  await page.getByTestId("undo-send-toast").getByRole("button", { name: "Send now" }).click();
  // Undo send holds the message on the device for a few seconds first.
  await expect.poll(() => outboxTo("friend@outside.example")?.subject, { timeout: 25_000 }).toBe(subject);
  expect(outboxTo("friend@outside.example")!.from.address).toBe(address);

  // Receive through the Email Worker, signed with the platform key.
  const inSubject = `Free address in ${stamp}`;
  expect(await receive(address, inSubject)).toBeNull();
  await page.goto(`${BASE}/app/mail`);
  await expect(page.getByText(inSubject).first()).toBeVisible({ timeout: 15_000 });
  // A name nobody has bounces.
  expect(await receive(`nobody.${stamp}@free.multies.test`, "x")).toMatch(/No mailbox/);
});
