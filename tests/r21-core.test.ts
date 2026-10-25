import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { CALL_DEDUPE_MS } from "@/server/services/suite/chat-reactions";

/** Round 21: REST for search everything, My Work, chat search and reactions; one call per channel a minute. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;

async function setup() {
  ctx = await makeTestApp();
  clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return m;
}
const general = async (cl: Client = c) => ((await cl.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
const post = async (channelId: string, body: string, cl: Client = c) => (await cl.post(`/api/chat/channels/${channelId}/messages`, { body })).body.message as { id: string };
const count = (t: string) => (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client.prepare(`select count(*) n from ${t}`).get().n;
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", host: "localhost" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> };
}
const keys = async () => ({
  full: (await c.post("/api/developer/keys", { name: "Bot" })).body.secret as string,
  ro: (await c.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string,
});

describe("REST: search everything and My Work", () => {
  beforeEach(setup);

  it("finds tasks and chat through /search/everything, refuses short queries and bad limits, and writes nothing", async () => {
    const g = await general();
    await post(g.id, "Harbourside launch plan is ready");
    await c.post("/api/tasks", { title: "Harbourside signage" });
    const { full, ro } = await keys();
    const before = count("audit_logs") + count("activity");
    const r = await api(full, "GET", "/search/everything?q=harbourside&types=tasks,chat&limit=5");
    expect(r.status).toBe(200);
    const groups = r.body.groups as { type: string; items: { title: string }[] }[];
    expect(groups.map((x) => x.type).sort()).toEqual(["chat", "tasks"]);
    expect((await api(ro, "GET", "/search/everything?q=harbourside")).status).toBe(200);
    expect((await api(full, "GET", "/search/everything?q=h")).status).toBe(422);
    expect((await api(full, "GET", "/search/everything?q=harbourside&limit=99")).status).toBe(422);
    expect((await api(full, "GET", "/search/everything?q=harbourside&types=secrets")).status).toBe(422);
    expect(count("audit_logs") + count("activity")).toBe(before);
    expect((await ctx.app.request("/api/v1/search/everything?q=harbourside")).status).toBe(401);
    // The agent mail search at /search is unchanged.
    expect((await api(full, "GET", "/search?q=harbourside")).status).toBe(200);
  });

  it("answers /my-work for the key's workspace and needs a key", async () => {
    const { full } = await keys();
    const r = await api(full, "GET", "/my-work?tz=Australia/Sydney");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("dueToday");
    expect(r.body).toHaveProperty("overdue");
    expect((await ctx.app.request("/api/v1/my-work")).status).toBe(401);
  });

  it("keeps another workspace's content out of search", async () => {
    await c.post("/api/tasks", { title: "Zebracorn roadmap" });
    const stranger = new Client(ctx.app);
    await stranger.signup("eve@else.io", "Eve Else");
    const theirs = (await stranger.post("/api/developer/keys", { name: "Theirs" })).body.secret as string;
    const r = await api(theirs, "GET", "/search/everything?q=zebracorn");
    expect(r.status).toBe(200);
    expect((r.body.groups as { items: unknown[] }[]).flatMap((x) => x.items)).toEqual([]);
  });
});

describe("REST: chat search and reactions", () => {
  beforeEach(setup);

  it("reacts and un-reacts through the API, refuses read only keys, DMs and bad emoji", async () => {
    const mate = await teammate();
    const g = await general();
    const m = await post(g.id, "Release notes are out");
    const me = (await mate.get("/api/account/me")).body.user.id as string;
    const dm = (await c.post("/api/chat/dms", { userIds: [me] })).body.channel;
    const secret = await post(dm.id, "Just us");
    const { full, ro } = await keys();
    const up = "\u{1F44D}";
    const r1 = await api(full, "POST", `/chat/messages/${m.id}/reactions`, { emoji: up });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ added: true, reactions: [{ emoji: up, count: 1 }] });
    // People see the key's reaction in the app.
    const seen = (await mate.get(`/api/chat/channels/${g.id}/messages`)).body.messages.find((x: { id: string }) => x.id === m.id);
    expect(seen.reactions[0]).toMatchObject({ emoji: up, count: 1 });
    expect((await api(full, "POST", `/chat/messages/${m.id}/reactions`, { emoji: up })).body).toMatchObject({ added: false, reactions: [] });
    expect((await api(ro, "POST", `/chat/messages/${m.id}/reactions`, { emoji: up })).status).toBe(403);
    expect((await api(full, "POST", `/chat/messages/${secret.id}/reactions`, { emoji: up })).status).toBe(404);
    expect((await api(full, "POST", `/chat/messages/${m.id}/reactions`, { emoji: "nice" })).status).toBe(422);
    expect((await api(full, "POST", `/chat/messages/${m.id}/reactions`, {})).status).toBe(422);
    expect(count("chat_reactions")).toBe(0);
  });

  it("searches public channels only, and one channel with channelId", async () => {
    const mate = await teammate();
    const g = await general();
    await post(g.id, "Invoice batch sent");
    const me = (await mate.get("/api/account/me")).body.user.id as string;
    const dm = (await c.post("/api/chat/dms", { userIds: [me] })).body.channel;
    await post(dm.id, "Invoice private note");
    const { ro } = await keys();
    const all = await api(ro, "GET", "/chat/search?q=invoice");
    expect(all.status).toBe(200);
    const results = all.body.results as { preview: string; channelId: string }[];
    expect(results.map((x) => x.preview)).toEqual(["Invoice batch sent"]);
    const one = await api(ro, "GET", `/chat/search?q=invoice&channelId=${g.id}`);
    expect((one.body.results as unknown[]).length).toBe(1);
    expect((await api(ro, "GET", "/chat/search?q=invoice&limit=500")).status).toBe(422);
  });
});

describe("calls: two presses within a minute make one meeting", () => {
  beforeEach(setup);

  it("joins the first call when someone presses Call again within 60 seconds, and starts a new one after", async () => {
    const mate = await teammate();
    const g = await general();
    const m0 = count("meetings"), c0 = count("chat_messages");
    const first = await c.post(`/api/chat/channels/${g.id}/call`, {});
    expect(first.status).toBe(201);
    expect(first.body.joined).toBe(false);
    const second = await mate.post(`/api/chat/channels/${g.id}/call`, {});
    expect(second.status).toBe(200);
    expect(second.body.joined).toBe(true);
    expect(second.body.meeting.id).toBe(first.body.meeting.id);
    expect(second.body.message.id).toBe(first.body.message.id);
    expect(count("meetings") - m0).toBe(1);
    expect(count("chat_messages") - c0).toBe(1);
    clock += CALL_DEDUPE_MS + 1000;
    const third = await mate.post(`/api/chat/channels/${g.id}/call`, {});
    expect(third.status).toBe(201);
    expect(third.body.meeting.id).not.toBe(first.body.meeting.id);
    expect(count("meetings") - m0).toBe(2);
  });

  it("makes one meeting when two people press Call at the same moment", async () => {
    const mate = await teammate();
    const g = await general();
    const m0 = count("meetings");
    const [a, b] = await Promise.all([c.post(`/api/chat/channels/${g.id}/call`, {}), mate.post(`/api/chat/channels/${g.id}/call`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.meeting.id).toBe(b.body.meeting.id);
    expect(count("meetings") - m0).toBe(1);
  });

  it("keeps calls in different channels apart, and starts fresh when the first call's join card is deleted", async () => {
    const g = await general();
    const other = (await c.post("/api/chat/channels", { name: "design" })).body.channel;
    const a = await c.post(`/api/chat/channels/${g.id}/call`, {});
    const b = await c.post(`/api/chat/channels/${other.id}/call`, {});
    expect(b.status).toBe(201);
    expect(b.body.meeting.id).not.toBe(a.body.meeting.id);
    expect((await c.call("DELETE", `/api/chat/messages/${a.body.message.id}`)).status).toBeLessThan(300);
    const again = await c.post(`/api/chat/channels/${g.id}/call`, {});
    expect(again.status).toBe(201);
    expect(again.body.meeting.id).not.toBe(a.body.meeting.id);
  });
});
