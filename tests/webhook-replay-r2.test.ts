/**
 * Round 2: a signed webhook replayed inside its signature window is answered 200 ("already handled") and not run again.
 * Each provider names its deliveries (Standard Webhooks webhook-id for Supabase and Resend; the Cloudflare Email Worker's
 * timestamp and signature; TikTok's signature header), and webhook_receipts keeps each name for about 10 minutes.
 * Stripe and agent-run hooks already dedupe on their own ids; WhatsApp and Messenger dedupe on the message id.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world";
import { messages, webhookReceipts } from "@/server/db/schema";
import { sign } from "../email-worker/src/index";
import { hmacSha256Hex } from "@/server/lib/crypto";
import { firstReceipt, pruneWebhookReceipts, RECEIPT_KEPT_MS } from "@/server/lib/webhook-receipts";
import { runMaintenance } from "@/server/services/maintenance";

const fault = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/services/mail/send", async (orig) => {
  const real = await orig<typeof import("@/server/services/mail/send")>();
  return { ...real, sendMessage: async (...a: Parameters<typeof real.sendMessage>) => {
    if (fault.on) throw new Error("provider down");
    return real.sendMessage(...a);
  } };
});

const RESEND_SECRET = `whsec_${Buffer.from("resend-replay-secret-0123456789").toString("base64")}`;
const HOOK_SECRET = `v1,whsec_${Buffer.from("supabase-replay-secret-0123456789").toString("base64")}`;
const TIKTOK = { TIKTOK_CLIENT_KEY: "ck_replay", TIKTOK_CLIENT_SECRET: "cs_replay_secret", TIKTOK_API_BASE: "https://tiktok.mock" };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;

beforeEach(async () => {
  ctx = await makeTestApp({ RESEND_WEBHOOK_SECRET: RESEND_SECRET, ...TIKTOK });
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  domainId = await verifiedDomain(ctx, c, "acme.io");
});

describe("Round 2: webhook replays", () => {
  it("firstReceipt says new once per source and id; the sweep drops receipts older than 10 minutes", async () => {
    expect(await firstReceipt(ctx.db, "resend", "a", ctx.deps.now())).toBe(true);
    expect(await firstReceipt(ctx.db, "resend", "a", ctx.deps.now())).toBe(false);
    expect(await firstReceipt(ctx.db, "tiktok", "a", ctx.deps.now())).toBe(true);
    expect(RECEIPT_KEPT_MS).toBe(10 * 60_000);
    await ctx.db.insert(webhookReceipts).values({ source: "resend", receiptId: "old", at: new Date(ctx.deps.now().getTime() - RECEIPT_KEPT_MS - 1000) });
    expect(await pruneWebhookReceipts(ctx.db, ctx.deps.now())).toBe(1);
    expect((await ctx.db.select().from(webhookReceipts).all()).map((r) => r.receiptId).sort()).toEqual(["a", "a"]);
    // The maintenance pass sweeps them too.
    await ctx.db.insert(webhookReceipts).values({ source: "resend", receiptId: "old2", at: new Date(0) });
    await runMaintenance(ctx.deps);
    expect((await ctx.db.select().from(webhookReceipts).where(eq(webhookReceipts.receiptId, "old2")).all())).toEqual([]);
  });

  it("Supabase auth hook: the same webhook-id twice sends one email; a failed send can be retried", async () => {
    expect((await c.post("/api/mailboxes", { domainId, localPart: "no-reply", displayName: "Acme" })).status).toBe(201);
    const key = (await c.post("/api/developer/keys", { name: "k" })).body.secret as string;
    const made = await ctx.app.request("/api/v1/auth-email-hooks", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ from: "no-reply@acme.io", secret: HOOK_SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" }) });
    expect(made.status).toBe(201);
    const path = new URL(((await made.json()) as { hook: { url: string } }).hook.url).pathname;
    const body = JSON.stringify({ user: { email: "new.user@example.com" }, email_data: { token: "1", token_hash: "h", redirect_to: "https://acme.io", email_action_type: "signup", site_url: "https://acme.io" } });
    const now = new Date();
    const headers = { "content-type": "application/json", "webhook-id": "wh_replay_1", "webhook-timestamp": String(Math.floor(now.getTime() / 1000)), "webhook-signature": new Webhook(HOOK_SECRET.replace(/^v1,/, "")).sign("wh_replay_1", now, body) };
    const before = ctx.outbound.sent.length;
    expect((await ctx.app.request(path, { method: "POST", headers, body })).status).toBe(200);
    expect(ctx.outbound.sent.length).toBe(before + 1);
    const again = await ctx.app.request(path, { method: "POST", headers, body });
    expect(again.status).toBe(200);
    expect(ctx.outbound.sent.length).toBe(before + 1);

    // A send that failed is not "handled": Supabase's retry with the same id goes through.
    const body2 = body.replace("new.user", "second.user");
    const h2 = { ...headers, "webhook-id": "wh_replay_2", "webhook-signature": new Webhook(HOOK_SECRET.replace(/^v1,/, "")).sign("wh_replay_2", now, body2) };
    fault.on = true;
    try { expect((await ctx.app.request(path, { method: "POST", headers: h2, body: body2 })).status).toBe(500); } finally { fault.on = false; }
    expect((await ctx.app.request(path, { method: "POST", headers: h2, body: body2 })).status).toBe(200);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("second.user@example.com"))).toHaveLength(1);
  });

  it("Resend events: the same svix-id twice is handled once", async () => {
    const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id as string;
    await c.post("/api/mail/send", { mailboxId, to: ["gone@example.com"], subject: "Hi", text: "Hello" });
    const sent = ctx.outbound.sent.at(-1)!;
    const body = JSON.stringify({ type: "email.bounced", data: { email_id: sent.messageId, to: ["gone@example.com"], bounce: { type: "Permanent", message: "550 user unknown" } } });
    const now = new Date();
    const headers = { "content-type": "application/json", "svix-id": "msg_replay_1", "svix-timestamp": String(Math.floor(now.getTime() / 1000)), "svix-signature": new Webhook(RESEND_SECRET).sign("msg_replay_1", now, body) };
    const first = await ctx.app.request("/api/webhooks/resend", { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ handled: true, updated: 1 });
    const again = await ctx.app.request("/api/webhooks/resend", { method: "POST", headers, body });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, replay: true });
  });

  it("Cloudflare inbound: the same signed delivery twice stores one message", async () => {
    await c.post("/api/mailboxes", { domainId, localPart: "help", displayName: "Help" });
    const key = (await c.post("/api/inbound-keys", {})).body.key as { id: string; secret: string };
    const raw = new TextEncoder().encode("From: pat@gmail.com\r\nTo: help@acme.io\r\nSubject: REPLAY-ONCE\r\nMessage-ID: <replay-once@gmail.com>\r\n\r\nHello\r\n");
    const ts = String(Math.floor(ctx.deps.now().getTime() / 1000));
    const signature = await sign(key.secret, ts, "pat@gmail.com", "help@acme.io", raw.buffer as ArrayBuffer);
    const send = () => ctx.app.request("/api/inbound/cloudflare", { method: "POST", headers: { host: "localhost", "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": "pat@gmail.com", "x-mymail-envelope-to": "help@acme.io", "x-mymail-signature": signature }, body: raw });
    const first = await send();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { action: string }).action).toBe("accept");
    const again = await send();
    expect(again.status).toBe(200);
    expect(((await again.json()) as { action: string }).action).toBe("accept");
    expect(await ctx.db.select({ id: messages.id }).from(messages).where(eq(messages.subject, "REPLAY-ONCE")).all()).toHaveLength(1);
  });

  it("TikTok: the same signed event twice is applied once", async () => {
    const body = JSON.stringify({ event: "authorization.removed", user_openid: "replay-user" });
    const t = Math.floor(ctx.deps.now().getTime() / 1000);
    const sig = `t=${t},s=${await hmacSha256Hex(TIKTOK.TIKTOK_CLIENT_SECRET, `${t}.${body}`)}`;
    const send = () => ctx.app.request("/api/connections/webhooks/tiktok", { method: "POST", headers: { "content-type": "application/json", "tiktok-signature": sig, host: "localhost" }, body });
    expect((await send()).status).toBe(200);
    expect(await ctx.db.select().from(webhookReceipts).where(eq(webhookReceipts.source, "tiktok")).all()).toHaveLength(1);
    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, replay: true });
  });
});
