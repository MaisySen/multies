import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { sign } from "../email-worker/src/index";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 26 (MB-80) end to end: a message sent from one mailbox gets an outside reply addressed to another
 * mailbox of the same workspace (the reply-to address, say). The reply arrives through the signed inbound
 * webhook the Email Worker calls, and the shared inbox shows both in one thread.
 */
let visitor = 0;
const ip = () => `10.126.${test.info().workerIndex % 200}.${++visitor}`;
const SHOT = process.env.R26_SHOT ?? `${SHOTS_ROOT}/multies-r26/r26-mail.png`;

test("an outside reply sent to another mailbox of the workspace joins the thread in the shared inbox", async ({ page, context }) => {
  test.setTimeout(60_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  const boxes = (await (await page.request.get("/api/mailboxes")).json()).mailboxes as { id: string; address: string; status: string }[];
  const active = boxes.filter((b) => b.status === "active");
  expect(active.length).toBeGreaterThan(1);
  const from = active[0]!;
  const other = active[1]!;
  const tag = Math.random().toString(36).slice(2, 6);
  const subject = `Spring order quote ${tag}`;

  const sent = await page.request.post("/api/mail/send", { headers, data: {
    mailboxId: from.id, to: ["pat.lee@example.org"], subject,
    text: "Hi Pat,\n\nHere is the quote for the spring order: 40 units at 18 each, delivered by 14 November.\n\nThanks",
    replyTo: other.address,
  } });
  expect(sent.status()).toBe(201);
  const messageId = (await sent.json()).messageId as string;
  const mine = (await (await page.request.get(`/api/mail/messages/${messageId}`)).json()).message as { messageIdHeader: string; threadId: string };
  expect(mine.messageIdHeader).toMatch(/^<.+@.+>$/);

  // An inbound key for this workspace, as the Email Worker uses.
  const key = (await (await page.request.post("/api/inbound-keys", { headers })).json()).key as { id: string; secret: string };
  const raw = [
    `From: Pat Lee <pat.lee@example.org>`, `To: ${other.address}`, `Subject: Re: ${subject}`,
    `Message-ID: <reply.${tag}@example.org>`, `In-Reply-To: ${mine.messageIdHeader}`, `References: ${mine.messageIdHeader}`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
    "Thanks, that works. Please go ahead with 40 units.", "", "Pat",
  ].join("\r\n");
  const body = new TextEncoder().encode(raw);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = await sign(key.secret, ts, "pat.lee@example.org", other.address, body.buffer as ArrayBuffer);
  const posted = await page.request.post("/api/inbound/cloudflare", {
    headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": "pat.lee@example.org", "x-mymail-envelope-to": other.address, "x-mymail-signature": signature },
    data: Buffer.from(body),
  });
  expect((await posted.json()).action).toBe("accept");

  // One thread: the shared inbox thread holds the sent message and the reply from the other mailbox.
  const thread = (await (await page.request.get(`/api/agents/threads/${mine.threadId}`)).json()) as { messages: { subject: string; mailboxId: string }[] };
  expect(thread.messages.map((m) => m.mailboxId).sort()).toEqual([from.id, other.id].sort());

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/inbox?thread=${encodeURIComponent(mine.threadId)}`);
  await expect(page.getByText("Please go ahead with 40 units").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Here is the quote for the spring order/).first()).toBeVisible();
  mkdirSync(SHOT.slice(0, SHOT.lastIndexOf("/")), { recursive: true });
  await page.screenshot({ path: SHOT });
});
