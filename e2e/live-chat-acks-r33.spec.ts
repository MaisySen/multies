import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 33 live chat: a message typed while the socket is reconnecting is held (shown as Sending),
 * goes out after the server's hello, and lands exactly once (the ack swaps in the server's copy).
 */
let visitor = 0;
const ip = () => `10.133.${test.info().workerIndex % 200}.${++visitor}`;

async function owner(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return headers;
}

test("a send during a forced reconnect is held until hello and lands exactly once", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await owner(page);
  // Polls stretched to 10 minutes: only the socket and the ack can put the message on screen.
  await page.addInitScript(() => { (window as unknown as { __MULTIES_CHAT_POLL_MS?: unknown }).__MULTIES_CHAT_POLL_MS = { live: 600_000, fallback: 600_000 }; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/chat");
  const box = page.getByTestId("chat-composer");
  await expect(box).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __MULTIES_LIVE_CHAT__?: { ready: boolean } }).__MULTIES_LIVE_CHAT__?.ready === true, undefined, { timeout: 30_000 });

  // Drop the socket as a network blip would, and send at once, before it is back.
  await page.evaluate(() => (window as unknown as { __MULTIES_LIVE_CHAT__: { drop(): void } }).__MULTIES_LIVE_CHAT__.drop());
  const body = `Held until hello ${Date.now().toString().slice(-6)}`;
  await box.fill(body);
  await box.press("Enter");
  const pending = page.getByTestId("chat-pending-item").filter({ hasText: body });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Sending");
  const shots = `${SHOTS_ROOT}/multies-r33`;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/chat-sending.png` });

  // The socket comes back, says hello, the held send goes, the ack swaps in the real message.
  const msg = page.getByRole("region", { name: /^Messages in / }).getByTestId("chat-message").filter({ hasText: body });
  await expect(msg).toHaveCount(1, { timeout: 30_000 });
  await expect(pending).toHaveCount(0);
  await page.waitForFunction(() => (window as unknown as { __MULTIES_LIVE_CHAT__?: { ready: boolean } }).__MULTIES_LIVE_CHAT__?.ready === true);

  // Exactly one row on the server.
  const channels = (await (await page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  const general = channels.find((c) => c.name === "general")!;
  const list = (await (await page.request.get(`/api/chat/channels/${general.id}/messages?limit=100`)).json()).messages as { body: string }[];
  expect(list.filter((m) => m.body === body)).toHaveLength(1);
  await expect(msg).toHaveCount(1);
});
