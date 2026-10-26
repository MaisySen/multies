import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { helloFrame, MemoryChatHub, type ChatLiveEvent, type HubConn } from "@/server/realtime/hub";
import { hash36, isClientMsgId, messageIdForClient, CLIENT_ID_SKEW_MS } from "@/server/services/suite/chat-ack-r33";
import { LiveChatConnection, type Clock, type SocketLike } from "@/web/lib/live-chat";
import { AUTO_TRIES, canFlush, ChatOutbox, HOLD_MAX_MS, newClientMsgId, pendingFor, SEND_TIMEOUT_MS, type OutboxClock, type SendResult, type OutboxItem } from "@/web/lib/chat-outbox";

/** Round 33: chat sends carry a client id, the server acks it and dedupes repeats, and the tab holds sends until hello. */

class FakeClock implements Clock, OutboxClock {
  t = 0;
  timers: { id: number; at: number; fn: () => void; every?: number }[] = [];
  private n = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.timers = this.timers.filter((x) => x.id !== id); }
  setInterval(fn: () => void, ms: number) { const id = ++this.n; this.timers.push({ id, at: this.t + ms, fn, every: ms }); return id; }
  clearInterval(id: unknown) { this.clearTimeout(id); }
  random() { return 0.5; }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every; else this.timers = this.timers.filter((x) => x !== next);
      next.fn();
    }
    this.t = end;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settleAll() { for (let i = 0; i < 6; i++) await tick(); }

describe("client ids and message ids", () => {
  it("a client id is 9 time characters and 12 random ones, and maps to one sortable message id", () => {
    const id = newClientMsgId(1_760_000_000_000, () => 0.5);
    expect(id).toHaveLength(21);
    expect(isClientMsgId(id)).toBe(true);
    const now = 1_760_000_000_000;
    const a = messageIdForClient("org1", "member:u1", id, now)!;
    expect(a).toMatch(/^chm_[0-9a-z]{19}$/);
    expect(messageIdForClient("org1", "member:u1", id, now + 5000)).toBe(a);
    expect(messageIdForClient("org1", "member:u2", id, now)).not.toBe(a);
    expect(messageIdForClient("org2", "member:u1", id, now)).not.toBe(a);
    // Sorts by send time like sortableId does.
    const later = messageIdForClient("org1", "member:u1", newClientMsgId(now + 1, () => 0.1), now)!;
    expect(later > a).toBe(true);
  });
  it("refuses a bad shape or a clock more than a day off", () => {
    const now = 1_760_000_000_000;
    expect(messageIdForClient("o", "member:u", "NOT-OK", now)).toBeNull();
    expect(messageIdForClient("o", "member:u", undefined, now)).toBeNull();
    expect(messageIdForClient("o", "member:u", newClientMsgId(now - CLIENT_ID_SKEW_MS - 1), now)).toBeNull();
    expect(hash36("x")).toHaveLength(13);
  });
});

describe("hello frame", () => {
  it("carries the server time and the hub's publish count", async () => {
    expect(helloFrame(3, 0)).toEqual({ t: "hello", serverTime: "1970-01-01T00:00:00.000Z", seq: 3 });
    const hub = new MemoryChatHub(() => 1000);
    expect(hub.hello("o1").seq).toBe(0);
    const got: string[] = [];
    const c: HubConn = { userId: "u1", openedAt: 1000, send: (d) => got.push(d), close: () => undefined };
    hub.join("o1", c);
    const ev: ChatLiveEvent = { t: "typing", channelId: "c", userId: "u2", name: "Sam" };
    await hub.publish("o1", { all: true }, ev);
    await hub.publish("o1", { all: true }, ev);
    expect(hub.hello("o1").seq).toBe(2);
    expect(hub.hello("o2").seq).toBe(0);
  });
});

describe("posting with a client id (app)", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: Client;
  let hub: MemoryChatHub;
  let orgId = "";
  beforeEach(async () => {
    ctx = await makeTestApp();
    hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    orgId = (await owner.get("/api/account/me")).body.organization.id;
  });
  it("acks with reply_to, and a repeat returns the first message without a second row or event", async () => {
    const me = (await owner.get("/api/account/me")).body.user.id as string;
    const got: string[] = [];
    hub.join(orgId, { userId: me, openedAt: Date.now(), send: (d) => got.push(d), close: () => undefined });
    const general = ((await owner.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((c) => c.name === "general")!;
    const cid = newClientMsgId(ctx.deps.now().getTime());
    const first = await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "Once only", clientMsgId: cid });
    expect(first.status).toBe(201);
    expect(first.body.ack).toMatchObject({ type: "ack", reply_to: cid, ok: true, deduped: false, message: { id: first.body.message.id } });
    expect(typeof first.body.ack.message.ts).toBe("string");
    const again = await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "Once only", clientMsgId: cid });
    expect(again.status).toBe(200);
    expect(again.body.ack).toMatchObject({ reply_to: cid, ok: true, deduped: true, message: { id: first.body.message.id } });
    const list = (await owner.get(`/api/chat/channels/${general.id}/messages`)).body.messages as { body: string }[];
    expect(list.filter((m) => m.body === "Once only")).toHaveLength(1);
    const created = got.map((g) => JSON.parse(g) as ChatLiveEvent).filter((e) => e.t === "message" && e.op === "created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ clientMsgId: cid });
  });
  it("a send without a client id is unchanged; a bad one is refused", async () => {
    const general = ((await owner.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((c) => c.name === "general")!;
    const plain = await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "Plain" });
    expect(plain.status).toBe(201);
    expect(plain.body.ack).toBeUndefined();
    expect((await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "Bad", clientMsgId: "../x" })).status).toBe(422);
  });
  it("the same client id in another channel is a conflict, not a silent repeat", async () => {
    const chans = (await owner.get("/api/chat/channels")).body.channels as { id: string; name: string }[];
    const general = chans.find((c) => c.name === "general")!;
    const other = (await owner.post("/api/chat/channels", { name: "ops" })).body.channel as { id: string };
    const cid = newClientMsgId(ctx.deps.now().getTime());
    expect((await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "A", clientMsgId: cid })).status).toBe(201);
    expect((await owner.post(`/api/chat/channels/${other.id}/messages`, { body: "A", clientMsgId: cid })).status).toBe(409);
  });
});

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(d: string) { this.sent.push(d); }
  close() { /* test */ }
  open() { this.onopen?.({}); }
  push(data: string) { this.onmessage?.({ data }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}

describe("live connection: hello", () => {
  it("is ready only after hello, not on open; a drop clears it; a lower seq means read once", () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const ready: boolean[] = [];
    const events: unknown[] = [];
    let resyncs = 0;
    const c = new LiveChatConnection({ url: "ws://x", clock, makeSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; }, onEvent: (e) => events.push(e), onResync: () => { resyncs++; }, onReady: (r) => ready.push(r) });
    c.start();
    sockets[0].open();
    expect(c.ready).toBe(false);
    sockets[0].push(JSON.stringify({ t: "hello", serverTime: "x", seq: 5 }));
    expect(c.ready).toBe(true);
    expect(events).toHaveLength(0); // hello is not a chat event
    sockets[0].drop();
    expect(c.ready).toBe(false);
    clock.advance(1000);
    sockets[1].open();
    expect(resyncs).toBe(1); // the reconnect itself
    sockets[1].push(JSON.stringify({ t: "hello", serverTime: "x", seq: 0 }));
    expect(resyncs).toBe(2); // the hub restarted
    expect(ready).toEqual([true, false, true]);
    c.stop();
  });
});

describe("chat outbox", () => {
  function setup(results: Array<SendResult | "hang" | "throw">) {
    const clock = new FakeClock();
    const sent: OutboxItem[] = [];
    const acked: string[] = [];
    const hangs: Array<(r: SendResult) => void> = [];
    const box = new ChatOutbox({
      clock,
      onAcked: (id) => acked.push(id),
      send: (item) => {
        sent.push({ ...item });
        const r = results.shift() ?? ok(item.clientMsgId);
        if (r === "hang") return new Promise((res) => hangs.push(res));
        if (r === "throw") return Promise.reject(new Error("offline"));
        return Promise.resolve(typeof r === "function" ? r : r);
      },
    });
    return { clock, box, sent, acked, hangs };
  }
  const ok = (id: string, serverId = `chm_${id}`): SendResult => ({ ok: true, ack: { type: "ack", reply_to: id, ok: true, message: { id: serverId, ts: "t" } }, message: { id: serverId, channelId: "c" } });
  const net: SendResult = { ok: false, retryable: true, error: "Can't reach Multies." };

  it("holds sends until hello, then sends them in order", async () => {
    const { box, sent, acked } = setup([]);
    box.setReady(false);
    box.enqueue({ channelId: "c", body: "one", clientMsgId: "a".repeat(21) });
    box.enqueue({ channelId: "c", body: "two", clientMsgId: "b".repeat(21) });
    await settleAll();
    expect(sent).toHaveLength(0);
    expect(box.items.map((i) => i.state)).toEqual(["queued", "queued"]);
    box.setReady(true);
    await settleAll();
    expect(sent.map((s) => s.body)).toEqual(["one", "two"]);
    expect(acked).toEqual(["a".repeat(21), "b".repeat(21)]);
    expect(box.items).toHaveLength(0);
  });
  it("does not wait forever: after the hold the sends go anyway (polling fallback)", async () => {
    const { box, sent, clock } = setup([]);
    box.setReady(false);
    box.enqueue({ channelId: "c", body: "hi" });
    clock.advance(HOLD_MAX_MS - 1);
    await settleAll();
    expect(sent).toHaveLength(0);
    clock.advance(1);
    await settleAll();
    expect(sent).toHaveLength(1);
    expect(canFlush({ ready: false, heldSince: 0, now: HOLD_MAX_MS })).toBe(true);
    expect(canFlush({ ready: false, heldSince: null, now: 99 })).toBe(false);
  });
  it("a network failure is retried exactly once after the next hello, with the same client id", async () => {
    const { box, sent } = setup([net, net]);
    box.setReady(true);
    const id = box.enqueue({ channelId: "c", body: "hi" });
    await settleAll();
    expect(sent).toHaveLength(1);
    expect(box.items[0].state).toBe("queued");
    box.setReady(false);
    box.setReady(true); // reconnected: hello
    await settleAll();
    expect(sent).toHaveLength(AUTO_TRIES);
    expect(sent.every((s) => s.clientMsgId === id)).toBe(true);
    expect(box.items[0].state).toBe("failed");
    box.setReady(false); box.setReady(true);
    await settleAll();
    expect(sent).toHaveLength(AUTO_TRIES); // no third automatic try
  });
  it("a refusal fails at once; tap to retry sends it again under the same id", async () => {
    const { box, sent } = setup([{ ok: false, retryable: false, error: "This channel is archived." }]);
    box.setReady(true);
    const id = box.enqueue({ channelId: "c", body: "hi" });
    await settleAll();
    expect(box.items[0]).toMatchObject({ state: "failed", error: "This channel is archived." });
    box.retry(id);
    await settleAll();
    expect(sent.map((s) => s.clientMsgId)).toEqual([id, id]);
    expect(box.items).toHaveLength(0);
  });
  it("no answer in time shows Not sent; a late ack still settles it; a thrown send counts as network", async () => {
    const { box, clock, hangs } = setup(["hang"]);
    box.setReady(true);
    const id = box.enqueue({ channelId: "c", body: "slow" });
    await settleAll();
    clock.advance(SEND_TIMEOUT_MS);
    expect(box.items[0].state).toBe("failed");
    hangs[0](ok(id));
    await settleAll();
    expect(box.items).toHaveLength(0);
    const t = setup(["throw"]);
    t.box.setReady(true);
    t.box.enqueue({ channelId: "c", body: "x" });
    await settleAll();
    expect(t.box.items[0].state).toBe("queued");
  });
  it("a live event with the client id settles the pending bubble; pending lists split by thread", () => {
    const { box } = setup(["hang"]);
    box.setReady(false);
    const id = box.enqueue({ channelId: "c", body: "top" });
    box.enqueue({ channelId: "c", parentId: "p1", body: "reply" });
    expect(pendingFor(box.items, "c", null).map((i) => i.body)).toEqual(["top"]);
    expect(pendingFor(box.items, "c", "p1").map((i) => i.body)).toEqual(["reply"]);
    box.settle(id, { id: "chm_x" });
    expect(pendingFor(box.items, "c", null)).toHaveLength(0);
    expect(box.acked.get(id)?.id).toBe("chm_x");
  });
});
