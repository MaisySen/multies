import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { webPushSubscriptions } from "@/server/db/schema";
import { decryptPayload } from "@/server/lib/web-push";
import { MAX_FAILURES, webPushPayload, webPushToUsers, webPushUrl } from "@/server/services/suite/web-push-r32";
import { categoryOf, notify } from "@/server/services/suite/notify";

// RFC 8291 keys: the server key signs, the user agent key decrypts what we send.
const VAPID = { VAPID_PUBLIC_KEY: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8", VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", VAPID_SUBJECT: "mailto:security@multies.si" };
const UA = { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", priv: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", auth: "BTBZMqHH6r4Tts7J_aSIgg" };
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: UA.p256dh, auth: UA.auth } });

type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
function pushFetch(statusFor: (url: string) => number = () => 201) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: new Uint8Array(init.body as ArrayBuffer) });
    return new Response(null, { status: statusFor(url) });
  }) as unknown as typeof fetch;
  return { sent, f };
}

async function setup(env: Record<string, string> = VAPID, statusFor?: (url: string) => number) {
  const { sent, f } = pushFetch(statusFor);
  const ctx = await makeTestApp(env, { fetch: f });
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const me = (await owner.get("/api/account/me")).body;
  return { ctx, owner, sent, me };
}

describe("web push subscriptions (R32)", () => {
  it("is off without VAPID keys: config has no key and saving is refused", async () => {
    const { owner } = await setup({});
    expect((await owner.get("/api/config")).body.vapidPublicKey).toBeNull();
    const r = await owner.post("/api/push/web", sub(1));
    expect(r.status).toBe(409);
    expect((await owner.get("/api/push/web")).body.enabled).toBe(false);
  });

  it("saves, lists by host only, updates in place and deletes a browser", async () => {
    const { owner } = await setup();
    expect((await owner.get("/api/config")).body.vapidPublicKey).toBe(VAPID.VAPID_PUBLIC_KEY);
    expect((await owner.post("/api/push/web", sub(1))).status).toBe(201);
    expect((await owner.post("/api/push/web", sub(1))).status).toBe(201);
    const list = (await owner.get("/api/push/web")).body;
    expect(list.enabled).toBe(true);
    expect(list.publicKey).toBe(VAPID.VAPID_PUBLIC_KEY);
    expect(list.subscriptions).toHaveLength(1);
    expect(list.subscriptions[0].host).toBe("fcm.googleapis.com");
    expect(JSON.stringify(list)).not.toContain("device-1");
    expect((await owner.call("DELETE", "/api/push/web", { endpoint: sub(1).endpoint })).status).toBe(200);
    expect((await owner.get("/api/push/web")).body.subscriptions).toHaveLength(0);
  });

  it("refuses non push endpoints and bad keys, and needs a session", async () => {
    const { owner, ctx } = await setup();
    expect((await owner.post("/api/push/web", { ...sub(1), endpoint: "http://fcm.googleapis.com/x" })).status).toBe(422);
    expect((await owner.post("/api/push/web", { ...sub(1), endpoint: "https://127.0.0.1/x" })).status).toBe(422);
    expect((await owner.post("/api/push/web", { endpoint: sub(1).endpoint, keys: { p256dh: "short", auth: UA.auth } })).status).toBe(422);
    expect((await new Client(ctx.app).post("/api/push/web", sub(1))).status).toBe(401);
  });

  it("keeps ten browsers per person at most", async () => {
    const { owner } = await setup();
    for (let i = 0; i < 12; i++) await owner.post("/api/push/web", sub(i));
    expect((await owner.get("/api/push/web")).body.subscriptions).toHaveLength(10);
  });
});

describe("web push sending (R32)", () => {
  it("a notification reaches the browser encrypted, with a title and the page, respecting per category settings", async () => {
    const { ctx, owner, sent, me } = await setup();
    await owner.post("/api/push/web", sub(1));
    const orgId = me.organization.id as string; const userId = me.user.id as string;
    await notify(ctx.deps, orgId, userId, { type: "task.assigned", entityType: "task", entityId: "tsk_9", title: "Maya assigned you Q3 plan" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(sub(1).endpoint);
    expect(sent[0].headers["content-encoding"]).toBe("aes128gcm");
    expect(sent[0].headers.authorization).toMatch(/^vapid t=.+, k=BP4z9/);
    const payload = JSON.parse(new TextDecoder().decode(await decryptPayload(sent[0].body, UA.priv, UA.p256dh, UA.auth)));
    expect(payload).toEqual({ type: "task.assigned", id: "tsk_9", title: "Maya assigned you Q3 plan", body: "Open in Multies", url: "/app/tasks?task=tsk_9", tag: "task:tsk_9", sentAt: expect.any(Number), ttl: 21600 });
    // Turning the category's push switch off stops browser alerts too.
    await owner.put("/api/notifications/settings", { settings: { [categoryOf("task.assigned")]: { push: false } } });
    sent.length = 0;
    await notify(ctx.deps, orgId, userId, { type: "task.assigned", entityType: "task", entityId: "tsk_10", title: "Another" });
    expect(sent).toHaveLength(0);
  });

  it("410 deletes the subscription; other failures count up and drop after five", async () => {
    const { ctx, owner, me } = await setup(VAPID, (url) => (url.endsWith("device-1") ? 410 : url.endsWith("device-2") ? 500 : 201));
    for (const n of [1, 2, 3]) await owner.post("/api/push/web", sub(n));
    const orgId = me.organization.id as string; const userId = me.user.id as string;
    const r = await webPushToUsers(ctx.deps, orgId, [userId], { type: "task.assigned", id: "t1" });
    expect(r).toEqual({ sent: 1, removed: 1, failed: 1 });
    const rows = await ctx.db.select().from(webPushSubscriptions);
    expect(rows.map((x) => x.endpoint).sort()).toEqual([sub(2).endpoint, sub(3).endpoint]);
    expect(rows.find((x) => x.endpoint === sub(2).endpoint)!.failures).toBe(1);
    expect(rows.find((x) => x.endpoint === sub(3).endpoint)!.lastOkAt).toBeTruthy();
    for (let i = 1; i < MAX_FAILURES; i++) await webPushToUsers(ctx.deps, orgId, [userId], { type: "task.assigned", id: "t1" });
    expect(await ctx.db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, sub(2).endpoint))).toHaveLength(0);
  });

  it("another person's browser never gets my alerts, and new mail carries no subject", async () => {
    const { ctx, owner, sent, me } = await setup();
    await owner.post("/api/push/web", sub(1));
    const r = await webPushToUsers(ctx.deps, me.organization.id, ["usr_someone_else"], { type: "message.received", id: "msg_1" });
    expect(r.sent).toBe(0);
    expect(sent).toHaveLength(0);
    expect(webPushPayload({ type: "message.received", id: "msg_1" })).toEqual({ type: "message.received", id: "msg_1", title: "New mail", body: "Open in Multies", url: "/app/mail?m=msg_1", tag: "message:msg_1", sentAt: expect.any(Number), ttl: 21600 });
    expect(webPushUrl({ type: "thread_mention", id: "thr_1", mid: "msg_2" })).toBe("/app/inbox?thread=thr_1&m=msg_2");
    expect(webPushUrl({ type: "weird", id: "x" })).toBe("/app/notifications");
  });
});
