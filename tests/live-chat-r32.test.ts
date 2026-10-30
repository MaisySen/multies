import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { makeTestApp, Client } from "./helpers";
import { deliver, MemoryChatHub, SOCKET_MAX_AGE_MS, CLOSE_EXPIRED, type ChatLiveEvent, type HubConn } from "@/server/realtime/hub";
import { ChatHub } from "@/server/realtime/chat-hub-do";
import { chatLiveAccess } from "@/server/realtime/access";
import { publishChat } from "@/server/realtime/publish";
import { applyLiveEvent, backoffDelay, chatPollMs, LiveChatConnection, PING_EVERY_MS, PONG_WAIT_MS, TypingStore, typingText, typingThrottle, type Clock, type LiveEvent, type SocketLike } from "@/web/lib/live-chat";

/** Round 32: live chat over a socket, with the poll as the fallback. */

function conn(userId: string, openedAt = 0) {
  const got: string[] = [];
  const closed: number[] = [];
  const c: HubConn = { userId, openedAt, send: (d) => { got.push(d); }, close: (code) => { closed.push(code); } };
  return { c, got, closed, events: () => got.map((g) => JSON.parse(g) as ChatLiveEvent) };
}
const msgEvent = (channelId = "ch1"): ChatLiveEvent => ({ t: "message", op: "created", channelId, message: { id: "m1", channelId, parentId: null } });

describe("hub routing", () => {
  it("sends public channel events to everyone and private ones to members only", () => {
    const a = conn("u1"), b = conn("u2"), b2 = conn("u2"), c = conn("u3");
    expect(deliver([a.c, b.c, b2.c, c.c], { all: true }, msgEvent(), 1000)).toBe(4);
    expect(deliver([a.c, b.c, b2.c, c.c], { userIds: ["u2"] }, msgEvent(), 1000)).toBe(2);
    expect(a.got).toHaveLength(1);
    expect(b.got).toHaveLength(2);
    expect(c.got).toHaveLength(1);
  });
  it("never sends a typing beat back to the person typing", () => {
    const a = conn("u1"), b = conn("u2");
    deliver([a.c, b.c], { all: true }, { t: "typing", channelId: "ch1", userId: "u1", name: "Maya" }, 1000);
    expect(a.got).toHaveLength(0);
    expect(b.events()[0]).toMatchObject({ t: "typing", name: "Maya" });
  });
  it("closes sockets past their age instead of sending (the browser reconnects with a fresh session check)", () => {
    const old = conn("u1", 0), fresh = conn("u1", SOCKET_MAX_AGE_MS);
    deliver([old.c, fresh.c], { all: true }, msgEvent(), SOCKET_MAX_AGE_MS + 5);
    expect(old.got).toHaveLength(0);
    expect(old.closed).toEqual([CLOSE_EXPIRED]);
    expect(fresh.got).toHaveLength(1);
  });
  it("MemoryChatHub keeps workspaces apart", async () => {
    const hub = new MemoryChatHub(() => 1000);
    const a = conn("u1", 1000), x = conn("u1", 1000);
    hub.join("org1", a.c);
    hub.join("org2", x.c);
    await hub.publish("org1", { all: true }, msgEvent());
    expect(a.got).toHaveLength(1);
    expect(x.got).toHaveLength(0);
    hub.leave("org1", a.c);
    expect(hub.hubs.has("org1")).toBe(false);
  });
});

describe("ChatHub Durable Object", () => {
  function fakeState() {
    const sockets: { att: unknown; sent: string[]; closed: number[]; send(d: string): void; close(code?: number): void; serializeAttachment(v: unknown): void; deserializeAttachment(): unknown }[] = [];
    const make = (att: unknown) => {
      const s = { att, sent: [] as string[], closed: [] as number[], send(d: string) { this.sent.push(d); }, close(code?: number) { this.closed.push(code ?? 1000); }, serializeAttachment(v: unknown) { this.att = v; }, deserializeAttachment() { return this.att; } };
      sockets.push(s);
      return s;
    };
    return { sockets, make, state: { acceptWebSocket: () => undefined, getWebSockets: () => sockets } };
  }
  it("routes a publish by audience using each socket's attachment", async () => {
    const f = fakeState();
    const hub = new ChatHub(f.state as never, {}, () => 5000);
    const s1 = f.make({ userId: "u1", openedAt: 5000 }), s2 = f.make({ userId: "u2", openedAt: 5000 });
    const res = await hub.fetch(new Request("https://chat-hub/publish", { method: "POST", body: JSON.stringify({ audience: { userIds: ["u2"] }, event: msgEvent() }) }));
    expect(await res.json()).toEqual({ sent: 1 });
    expect(s1.sent).toHaveLength(0);
    expect(JSON.parse(s2.sent[0])).toMatchObject({ t: "message", op: "created" });
  });
  it("refuses a publish without an audience and a plain GET", async () => {
    const f = fakeState();
    const hub = new ChatHub(f.state as never, {});
    expect((await hub.fetch(new Request("https://chat-hub/publish", { method: "POST", body: "{}" }))).status).toBe(400);
    expect((await hub.fetch(new Request("https://chat-hub/live"))).status).toBe(426);
  });
  it("answers a ping when auto response is unavailable", () => {
    const f = fakeState();
    const hub = new ChatHub(f.state as never, {});
    const s = f.make({ userId: "u1", openedAt: 0 });
    hub.webSocketMessage(s as never, "ping");
    hub.webSocketMessage(s as never, "anything else");
    expect(s.sent).toEqual(["pong"]);
  });
});

describe("chat live end to end on the app", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: Client;
  let hub: MemoryChatHub;
  const sockets = new Map<string, ReturnType<typeof conn>>();
  let orgId = "";

  async function member(email: string, name: string) {
    const invite = await owner.post("/api/team/invites", { email, role: "member" });
    const m = new Client(ctx.app);
    await m.signup(email, name, "");
    expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
  }
  const listen = (userId: string) => { const s = conn(userId, Date.now()); hub.join(orgId, s.c); sockets.set(userId, s); return s; };

  beforeEach(async () => {
    ctx = await makeTestApp();
    hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    orgId = (await owner.get("/api/account/me")).body.organization.id;
  });

  it("pushes posts, edits, deletes and reactions to everyone in a public channel", async () => {
    const sam = await member("sam@acme.io", "Sam Mate");
    const meId = (await owner.get("/api/account/me")).body.user.id as string;
    const mine = listen(meId), his = listen(sam.id);
    const general = ((await owner.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((c) => c.name === "general")!;
    const posted = (await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "Ship it" })).body.message;
    expect(his.events().at(-1)).toMatchObject({ t: "message", op: "created", channelId: general.id, message: { id: posted.id, body: "Ship it" } });
    expect(mine.events().at(-1)).toMatchObject({ t: "message", op: "created" });
    await owner.patch(`/api/chat/messages/${posted.id}`, { body: "Ship it today" });
    expect(his.events().at(-1)).toMatchObject({ t: "message", op: "updated", message: { body: "Ship it today" } });
    await sam.client.post(`/api/chat/messages/${posted.id}/reactions`, { emoji: "\u{1F44D}" });
    expect(mine.events().at(-1)).toMatchObject({ t: "reactions", messageId: posted.id, reactions: [{ emoji: "\u{1F44D}", count: 1 }] });
    await owner.del(`/api/chat/messages/${posted.id}`);
    expect(his.events().at(-1)).toMatchObject({ t: "message", op: "updated", message: { id: posted.id, deleted: true, body: "" } });
  });

  it("keeps private channels and DMs to their members, and read state to the reader", async () => {
    const sam = await member("sam@acme.io", "Sam Mate");
    const ana = await member("ana@acme.io", "Ana Other");
    const meId = (await owner.get("/api/account/me")).body.user.id as string;
    const mine = listen(meId), sams = listen(sam.id), anas = listen(ana.id);
    const priv = (await owner.post("/api/chat/channels", { name: "secret", private: true, memberIds: [sam.id] })).body.channel;
    await owner.post(`/api/chat/channels/${priv.id}/messages`, { body: "Just us" });
    expect(sams.events().some((e) => e.t === "message" && e.channelId === priv.id)).toBe(true);
    expect(anas.events().some((e) => "channelId" in e && e.channelId === priv.id)).toBe(false);
    const dm = (await owner.post("/api/chat/dms", { userIds: [ana.id] })).body.channel;
    await owner.post(`/api/chat/channels/${dm.id}/messages`, { body: "Hi Ana" });
    expect(anas.events().some((e) => e.t === "message" && e.channelId === dm.id)).toBe(true);
    expect(sams.events().some((e) => "channelId" in e && e.channelId === dm.id)).toBe(false);
    const before = sams.got.length;
    await owner.post(`/api/chat/channels/${dm.id}/read`, {});
    expect(mine.events().at(-1)).toMatchObject({ t: "read", channelId: dm.id, userId: meId });
    expect(sams.got.length).toBe(before);
    expect(anas.events().at(-1)?.t).toBe("message");
  });

  it("typing goes to the others, is throttled, and is refused for channels you cannot read", async () => {
    const sam = await member("sam@acme.io", "Sam Mate");
    const meId = (await owner.get("/api/account/me")).body.user.id as string;
    const mine = listen(meId), his = listen(sam.id);
    const general = ((await owner.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((c) => c.name === "general")!;
    expect((await owner.post(`/api/chat/channels/${general.id}/typing`, {})).body).toEqual({ ok: true, sent: true });
    expect(his.events().at(-1)).toEqual({ t: "typing", channelId: general.id, userId: meId, name: "Olive Owner" });
    expect(mine.got).toHaveLength(0);
    expect((await owner.post(`/api/chat/channels/${general.id}/typing`, {})).body).toEqual({ ok: true, sent: false });
    const priv = (await owner.post("/api/chat/channels", { name: "secret", private: true })).body.channel;
    expect((await sam.client.post(`/api/chat/channels/${priv.id}/typing`, {})).status).toBe(404);
  });

  it("a hub that fails or hangs never fails the write", async () => {
    const errors: unknown[] = [];
    ctx.deps.reportError = (e) => { errors.push(e); return undefined; };
    ctx.deps.chatLive = { publish: async () => { throw new Error("hub down"); } };
    const general = ((await owner.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((c) => c.name === "general")!;
    const r = await owner.post(`/api/chat/channels/${general.id}/messages`, { body: "Still works" });
    expect(r.status).toBe(201);
    expect(errors.length).toBe(1);
    ctx.deps.chatLive = { publish: () => new Promise(() => undefined) };
    const t0 = Date.now();
    await publishChat(ctx.deps, { id: general.id, orgId, kind: "channel", isPrivate: false }, msgEvent(general.id));
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("the socket needs a session cookie and this site's Origin", async () => {
    const up = (h: Record<string, string>) => new Request("http://localhost/api/chat/live", { headers: { upgrade: "websocket", host: "localhost", ...h } });
    expect(await chatLiveAccess(ctx.deps, new Request("http://localhost/api/chat/live"))).toMatchObject({ ok: false, status: 426 });
    expect(await chatLiveAccess(ctx.deps, up({ origin: "https://evil.example", cookie: "a=b" }))).toMatchObject({ ok: false, status: 403 });
    expect(await chatLiveAccess(ctx.deps, up({ origin: "http://localhost" }))).toMatchObject({ ok: false, status: 401 });
    expect(await chatLiveAccess(ctx.deps, up({ origin: "http://localhost", cookie: "nope=1" }))).toMatchObject({ ok: false, status: 401 });
    const cookie = (owner as unknown as { cookie?: string; cookies?: unknown }).cookie;
    if (typeof cookie === "string" && cookie) {
      expect(await chatLiveAccess(ctx.deps, up({ origin: "http://localhost", cookie }))).toMatchObject({ ok: true, orgId });
    }
  });
});

// ---------------------------------------------------------------- client

class FakeClock implements Clock {
  t = 0;
  private timers: { id: number; at: number; fn: () => void; every?: number }[] = [];
  private seq = 0;
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown) { this.timers = this.timers.filter((x) => x.id !== id); }
  setInterval(fn: () => void, ms: number) { const id = ++this.seq; this.timers.push({ id, at: this.t + ms, fn, every: ms }); return id; }
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
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(d: string) { this.sent.push(d); }
  close(code = 1000) { this.closedWith = code; }
  open() { this.onopen?.({}); }
  push(data: string) { this.onmessage?.({ data }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}

describe("live chat client: connection and fallback", () => {
  function setup() {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const events: LiveEvent[] = [];
    let resyncs = 0;
    const c = new LiveChatConnection({ url: "ws://x/api/chat/live", clock, makeSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; }, onEvent: (e) => events.push(e), onResync: () => { resyncs++; } });
    return { clock, sockets, events, c, resyncs: () => resyncs };
  }
  it("opens, delivers events, and reconnects with backoff after a drop", () => {
    const { clock, sockets, events, c, resyncs } = setup();
    c.start();
    expect(c.state).toBe("connecting");
    sockets[0].open();
    expect(c.state).toBe("open");
    sockets[0].push(JSON.stringify({ t: "typing", channelId: "c", userId: "u", name: "Maya" }));
    sockets[0].push("not json");
    expect(events).toHaveLength(1);
    sockets[0].drop();
    expect(c.state).toBe("reconnecting");
    expect(c.everOpened).toBe(true);
    clock.advance(999);
    expect(sockets).toHaveLength(1); // not yet: the first retry is at 1 s (jitter 0.5 -> exactly 1000 * 1.0)
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    clock.advance(2000);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(c.state).toBe("open");
    expect(resyncs()).toBe(1);
  });
  it("a missing pong closes the socket and reconnects", () => {
    const { clock, sockets, c } = setup();
    c.start();
    sockets[0].open();
    clock.advance(PING_EVERY_MS);
    expect(sockets[0].sent).toEqual(["ping"]);
    sockets[0].push("pong");
    clock.advance(PONG_WAIT_MS + 10);
    expect(c.state).toBe("open");
    clock.advance(PING_EVERY_MS);
    clock.advance(PONG_WAIT_MS);
    expect(sockets[0].closedWith).toBe(4000);
    expect(c.state).toBe("reconnecting");
  });
  it("an expired socket reconnects at once; stop ends everything", () => {
    const { clock, sockets, c } = setup();
    c.start();
    sockets[0].open();
    sockets[0].drop(4001);
    clock.advance(800);
    expect(sockets).toHaveLength(2);
    c.stop();
    expect(c.state).toBe("stopped");
    clock.advance(120_000);
    expect(sockets).toHaveLength(2);
  });
  it("backoff doubles to 30 s with jitter", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(10, () => 0.5)).toBe(30000);
    expect(backoffDelay(10, () => 0)).toBe(21000);
    expect(backoffDelay(10, () => 1)).toBe(39000);
  });
  it("polls slowly while live and at the normal rate when not", () => {
    expect(chatPollMs(true, 4000)).toBe(60000);
    expect(chatPollMs(false, 4000)).toBe(4000);
    expect(chatPollMs(false, 15000)).toBe(15000);
  });
});

describe("live chat client: cache merge and typing", () => {
  const m = (id: string, at: string, extra: Record<string, unknown> = {}) => ({ id, channelId: "c1", parentId: null as string | null, createdAt: at, body: id, reactions: [] as unknown[], replyCount: 0, ...extra });
  it("adds a new message once, replaces an edited one, and keeps the order", () => {
    const qc = new QueryClient();
    qc.setQueryData(["chat", "messages", "c1"], [m("a", "2026-10-26T01:00:00Z"), m("b", "2026-10-26T02:00:00Z")]);
    const ev = (msg: ReturnType<typeof m>, op: "created" | "updated" = "created"): LiveEvent => ({ t: "message", op, channelId: "c1", message: msg });
    expect(applyLiveEvent(qc, ev(m("c", "2026-10-26T03:00:00Z")))).toEqual(["channels", "unread"]);
    applyLiveEvent(qc, ev(m("c", "2026-10-26T03:00:00Z")));
    applyLiveEvent(qc, ev(m("b", "2026-10-26T02:00:00Z", { body: "edited" }), "updated"));
    applyLiveEvent(qc, ev(m("x", "2026-10-26T00:30:00Z")));
    const list = qc.getQueryData<{ id: string; body: string }[]>(["chat", "messages", "c1"])!;
    expect(list.map((x) => x.id)).toEqual(["x", "a", "b", "c"]);
    expect(list.find((x) => x.id === "b")!.body).toBe("edited");
    // An update for a message not on screen is not added.
    applyLiveEvent(qc, ev(m("zz", "2026-10-26T04:00:00Z"), "updated"));
    expect(qc.getQueryData<unknown[]>(["chat", "messages", "c1"])).toHaveLength(4);
  });
  it("a reply goes into an open thread and bumps the parent's count; with no open thread the channel is refetched", () => {
    const qc = new QueryClient();
    qc.setQueryData(["chat", "messages", "c1"], [m("p", "2026-10-26T01:00:00Z")]);
    qc.setQueryData(["chat", "thread", "p"], { message: m("p", "2026-10-26T01:00:00Z"), replies: [] });
    const reply = m("r1", "2026-10-26T01:05:00Z", { parentId: "p" });
    applyLiveEvent(qc, { t: "message", op: "created", channelId: "c1", message: reply });
    applyLiveEvent(qc, { t: "message", op: "created", channelId: "c1", message: reply });
    expect(qc.getQueryData<{ replies: unknown[] }>(["chat", "thread", "p"])!.replies).toHaveLength(1);
    expect(qc.getQueryData<{ replyCount: number }[]>(["chat", "messages", "c1"])![0].replyCount).toBe(1);
    expect(applyLiveEvent(qc, { t: "message", op: "created", channelId: "c1", message: m("r2", "2026-10-26T01:06:00Z", { parentId: "q" }) })).toContain("messages");
  });
  it("reactions patch the message in the list and in an open thread", () => {
    const qc = new QueryClient();
    qc.setQueryData(["chat", "messages", "c1"], [m("p", "2026-10-26T01:00:00Z")]);
    qc.setQueryData(["chat", "thread", "p"], { message: m("p", "2026-10-26T01:00:00Z"), replies: [m("r1", "2026-10-26T01:05:00Z", { parentId: "p" })] });
    const reactions = [{ emoji: "\u{1F44D}", count: 1, reactors: [{ id: "member:u", name: "Maya" }] }];
    expect(applyLiveEvent(qc, { t: "reactions", channelId: "c1", messageId: "r1", reactions })).toEqual([]);
    applyLiveEvent(qc, { t: "reactions", channelId: "c1", messageId: "p", reactions });
    expect(qc.getQueryData<{ reactions: unknown[] }[]>(["chat", "messages", "c1"])![0].reactions).toEqual(reactions);
    const t = qc.getQueryData<{ message: { reactions: unknown[] }; replies: { reactions: unknown[] }[] }>(["chat", "thread", "p"])!;
    expect(t.message.reactions).toEqual(reactions);
    expect(t.replies[0].reactions).toEqual(reactions);
    expect(applyLiveEvent(qc, { t: "read", channelId: "c1", userId: "u", at: "x" })).toEqual(["channels", "unread"]);
  });
  it("typing shows names, expires, and the beat is throttled to one per 3 s", () => {
    let now = 0;
    const store = new TypingStore(() => now);
    store.add("c1", "u1", "Maya");
    store.add("c1", "u2", "Sam");
    expect(typingText(store.get("c1").map((x) => x.name))).toBe("Maya and Sam are typing");
    expect(store.get("c1")).toBe(store.get("c1"));
    store.remove("c1", "u2");
    expect(typingText(store.get("c1").map((x) => x.name))).toBe("Maya is typing");
    now = 7000;
    store.prune();
    expect(store.get("c1")).toHaveLength(0);
    expect(typingText(["a", "b", "c"])).toBe("Several people are typing");
    const sent: string[] = [];
    let t = 0;
    const beat = typingThrottle((id) => sent.push(id), () => t);
    beat("c1"); beat("c1"); t = 2999; beat("c1"); t = 3000; beat("c1"); beat("c2");
    expect(sent).toEqual(["c1", "c1", "c2"]);
  });
});
