import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { durablePresence, memoryPresence, presenceKey, PresenceRoom, PRESENCE_TTL_MS, ThreadPresence } from "@/server/collab/thread-presence";
import { threadPresence } from "@/server/services/suite/thread-collab";
import { deliverInbound } from "@/server/services/mail/delivery";

/** Round 22 (R22.3 live collision warning, R22.4 shared drafts). */

describe("PresenceRoom (the Durable Object's logic)", () => {
  const beat = (room: PresenceRoom, clientId: string, userId: string, state: "viewing" | "replying", now: number, name = userId) =>
    room.handle({ op: "beat", clientId, userId, name, state }, now);

  it("joins, beats, tells viewing from replying, and expires 40 seconds after the last beat", () => {
    const room = new PresenceRoom();
    let v = beat(room, "a1", "maya", "viewing", 0, "Maya Lee");
    expect(v.people).toEqual([expect.objectContaining({ userId: "maya", name: "Maya Lee", state: "viewing", tabs: 1 })]);
    v = beat(room, "s1", "sam", "replying", 1_000);
    // Replying sorts first.
    expect(v.people.map((p) => [p.userId, p.state])).toEqual([["sam", "replying"], ["maya", "viewing"]]);
    // Maya keeps beating every 15 s; Sam stops.
    beat(room, "a1", "maya", "viewing", 15_000);
    beat(room, "a1", "maya", "viewing", 30_000);
    v = room.handle({ op: "list" }, 1_000 + PRESENCE_TTL_MS - 1);
    expect(v.people.map((p) => p.userId).sort()).toEqual(["maya", "sam"]);
    v = room.handle({ op: "list" }, 1_000 + PRESENCE_TTL_MS);
    expect(v.people.map((p) => p.userId)).toEqual(["maya"]);
    v = room.handle({ op: "list" }, 30_000 + PRESENCE_TTL_MS);
    expect(v.people).toEqual([]);
    expect(room.empty).toBe(true);
  });

  it("folds two tabs of one person into one entry, replying wins, and leave removes only that tab", () => {
    const room = new PresenceRoom();
    beat(room, "t1", "maya", "viewing", 0);
    let v = beat(room, "t2", "maya", "replying", 2_000);
    expect(v.people).toHaveLength(1);
    expect(v.people[0]).toMatchObject({ state: "replying", tabs: 2 });
    v = room.handle({ op: "leave", clientId: "t2" }, 3_000);
    expect(v.people[0]).toMatchObject({ state: "viewing", tabs: 1 });
    v = room.handle({ op: "leave", clientId: "t1" }, 3_000);
    expect(v.people).toEqual([]);
  });

  it("keeps 'since' while the state holds and resets it on a change; notes expire", () => {
    const room = new PresenceRoom();
    beat(room, "t1", "maya", "viewing", 0);
    let v = beat(room, "t1", "maya", "viewing", 15_000);
    expect(v.people[0].since).toBe(new Date(0).toISOString());
    v = beat(room, "t1", "maya", "replying", 16_000);
    expect(v.people[0].since).toBe(new Date(16_000).toISOString());
    v = room.handle({ op: "note", note: { type: "draft_taken_over", draftId: "d1", toUserId: "maya", byUserId: "sam", byName: "Sam", subject: "Quote" } }, 17_000);
    expect(v.notes).toHaveLength(1);
    expect(room.handle({ op: "list" }, 17_000 + 120_000).notes).toHaveLength(0);
  });

  it("the Durable Object answers ops from memory and never touches storage", async () => {
    const storage = new Proxy({}, { get: () => { throw new Error("storage touched"); } });
    const obj = new ThreadPresence({ storage }, {});
    const post = (op: unknown) => obj.fetch(new Request("https://thread-presence/op", { method: "POST", body: JSON.stringify(op) }));
    const r = await post({ op: "beat", clientId: "c1", userId: "u1", name: "Una", state: "replying" });
    expect(r.status).toBe(200);
    expect((await r.json()).people[0]).toMatchObject({ userId: "u1", state: "replying" });
    expect((await post({ op: "nope" })).status).toBe(400);
    expect((await obj.fetch(new Request("https://thread-presence/op"))).status).toBe(405);
  });

  it("the Workers store reaches one object per org and thread through the binding", async () => {
    const objects = new Map<string, ThreadPresence>();
    const ns = {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const key = String(id);
        if (!objects.has(key)) objects.set(key, new ThreadPresence({}, {}));
        return objects.get(key)!;
      },
    };
    const store = durablePresence(ns);
    await store(presenceKey("org1", "thr1"), { op: "beat", clientId: "c1", userId: "u1", name: "Una", state: "viewing" });
    const other = await store(presenceKey("org1", "thr2"), { op: "list" });
    expect(other.people).toHaveLength(0);
    const same = await store(presenceKey("org1", "thr1"), { op: "list" });
    expect(same.people.map((p) => p.userId)).toEqual(["u1"]);
    expect([...objects.keys()]).toEqual(["org1:thr1", "org1:thr2"]);
    const broken = durablePresence({ idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("no", { status: 500 }) }) });
    await expect(broken("k", { op: "list" })).rejects.toThrow("500");
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let now = 1_800_000_000_000;
const tokenOf = (link: string) => link.split("/invite/")[1];

beforeEach(async () => {
  ctx = await makeTestApp();
  now = 1_800_000_000_000;
  ctx.deps.presence = memoryPresence(() => now);
});

async function inbound(to: string, subject: string, text: string) {
  const r = await deliverInbound(ctx.deps, {
    envelopeFrom: "grace@example.com", rcptTo: to, sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: "grace@example.com", name: "Grace" }, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  return r;
}

/** Olive (owner) with mailboxes sales and ceo, Max (member, sales only), and a thread in each. */
async function team() {
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const d = await owner.post("/api/domains", { name: "acme.io" });
  for (const r of d.body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await owner.post(`/api/domains/${d.body.domain.id}/verify`)).body.domain.status).toBe("verified");
  const salesId = (await owner.post("/api/mailboxes", { domainId: d.body.domain.id, localPart: "sales", displayName: "Sales" })).body.mailbox.id as string;
  const ceoId = (await owner.post("/api/mailboxes", { domainId: d.body.domain.id, localPart: "ceo", displayName: "CEO" })).body.mailbox.id as string;
  const inv = await owner.post("/api/team/invites", { email: "max@acme.io", role: "member", mailboxIds: [salesId] });
  const max = new Client(ctx.app);
  await max.signup("max@acme.io", "Max Member");
  expect((await max.post(`/api/invites/${tokenOf(inv.body.link)}/accept`)).status).toBe(200);
  await inbound("sales@acme.io", "Quote for the fit out", "Can you send a quote?");
  await inbound("ceo@acme.io", "Board pack", "Private.");
  const threads = (await owner.get("/api/agents/threads")).body.data as { threadId?: string; id?: string; subject: string }[];
  const tid = (subject: string) => { const t = threads.find((x) => x.subject === subject)!; return (t.threadId ?? t.id)!; };
  const salesThread = tid("Quote for the fit out"), ceoThread = tid("Board pack");
  const firstMsg = async (id: string) => (await owner.get(`/api/agents/threads/${id}`)).body.messages[0].id as string;
  const outsider = new Client(ctx.app);
  await outsider.signup("eve@other.io", "Eve Outsider", "Other");
  return { owner, max, outsider, salesId, ceoId, salesThread, ceoThread, salesMsg: await firstMsg(salesThread), ceoMsg: await firstMsg(ceoThread) };
}

describe("presence routes", () => {
  it("shows a teammate viewing then replying, hides yourself, and leaves", async () => {
    const t = await team();
    expect((await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab1", state: "viewing" })).status).toBe(200);
    let v = (await t.owner.post(`/api/threads/${t.salesThread}/presence`, { clientId: "olivetab1", state: "viewing" })).body;
    expect(v.people).toEqual([expect.objectContaining({ name: "Max Member", state: "viewing" })]);
    // Max opens a reply in a second tab: still one person, now replying.
    await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab2", state: "replying" });
    v = (await t.owner.get(`/api/threads/${t.salesThread}/presence`)).body;
    expect(v.people).toEqual([expect.objectContaining({ name: "Max Member", state: "replying", tabs: 2 })]);
    // Max never sees himself.
    expect((await t.max.get(`/api/threads/${t.salesThread}/presence`)).body.people.map((p: { name: string }) => p.name)).toEqual(["Olive Owner"]);
    await t.max.post(`/api/threads/${t.salesThread}/presence/leave`, { clientId: "maxtab2" });
    expect((await t.owner.get(`/api/threads/${t.salesThread}/presence`)).body.people[0].state).toBe("viewing");
    // Max's other tab stops beating: gone 40 s later.
    now += PRESENCE_TTL_MS;
    expect((await t.owner.get(`/api/threads/${t.salesThread}/presence`)).body.people).toEqual([]);
  });

  it("refuses a thread the caller can't open, other workspaces, bad input and no session", async () => {
    const t = await team();
    expect((await t.max.post(`/api/threads/${t.ceoThread}/presence`, { clientId: "maxtab1", state: "viewing" })).status).toBe(404);
    expect((await t.max.get(`/api/threads/${t.ceoThread}/presence`)).status).toBe(404);
    expect((await t.outsider.post(`/api/threads/${t.salesThread}/presence`, { clientId: "evetab1", state: "viewing" })).status).toBe(404);
    expect((await t.outsider.get(`/api/threads/${t.salesThread}/drafts`)).status).toBe(404);
    expect((await t.max.get(`/api/threads/${t.ceoThread}/drafts`)).status).toBe(404);
    expect((await new Client(ctx.app).get(`/api/threads/${t.salesThread}/presence`)).status).toBe(401);
    expect((await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "x", state: "typing" })).status).toBe(422);
    // A refused caller never reached the room.
    expect((await t.owner.get(`/api/threads/${t.ceoThread}/presence`)).body.people).toEqual([]);
  });

  it("a heartbeat performs zero D1 writes", async () => {
    const t = await team();
    const db = ctx.deps.db as unknown as Record<string, unknown>;
    const calls: string[] = [];
    const orig = { insert: db.insert, update: db.update, delete: db.delete, run: db.run };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) db[k] = (...a: unknown[]) => { calls.push(k); return (orig[k] as (...x: unknown[]) => unknown).apply(db, a); };
    try {
      const actor = { orgId: (await t.max.get("/api/account/me")).body.organization.id, userId: (await t.max.get("/api/account/me")).body.user.id, role: "member" as const, name: "Max" };
      for (let i = 0; i < 5; i++) { now += 15_000; await threadPresence(ctx.deps, actor, t.salesThread, { op: "beat", clientId: "maxtab1", state: i % 2 ? "replying" : "viewing" }); }
      await threadPresence(ctx.deps, actor, t.salesThread, { op: "list" });
      await threadPresence(ctx.deps, actor, t.salesThread, { op: "leave", clientId: "maxtab1" });
      expect(calls).toEqual([]);
    } finally { Object.assign(db, orig); }
    // And through the route, at the SQLite level: no row changes at all besides what any request costs.
    const client = (ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => { n: number } } } }).$client;
    const changes = () => client.prepare("select total_changes() n").get().n;
    // What any POST through the app costs (the local rate limit counter, a binding in production): a refused beat.
    await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "x", state: "viewing" });
    let before = changes();
    expect((await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "x", state: "viewing" })).status).toBe(422);
    const baseline = changes() - before;
    before = changes();
    now += 15_000;
    expect((await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab1", state: "replying" })).status).toBe(200);
    expect(changes() - before).toBeLessThanOrEqual(baseline);
  });
});

describe("shared drafts", () => {
  it("a draft reply carries the thread and its author; a teammate takes it over; the old author's save gets 409", async () => {
    const t = await team();
    const saved = await t.max.post("/api/mail/drafts", { mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote for the fit out", text: "We can start Monday.", inReplyToId: t.salesMsg });
    expect(saved.status).toBe(201);
    const draftId = saved.body.id as string;
    // The owner sees it in the thread, with Max as the author.
    let list = (await t.owner.get(`/api/threads/${t.salesThread}/drafts`)).body.drafts;
    expect(list).toEqual([expect.objectContaining({ id: draftId, author: expect.objectContaining({ name: "Max Member" }), mine: false, snippet: "We can start Monday." })]);
    expect((await t.max.get(`/api/threads/${t.salesThread}/drafts`)).body.drafts[0].mine).toBe(true);
    // The thread view itself still leaves drafts out.
    expect((await t.owner.get(`/api/agents/threads/${t.salesThread}`)).body.messages.some((m: { id: string }) => m.id === draftId)).toBe(false);
    // Max is live in the thread when Olive takes over.
    await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab1", state: "replying" });
    const took = await t.owner.post(`/api/threads/drafts/${draftId}/take-over`);
    expect(took.status).toBe(200);
    expect(took.body.draft).toMatchObject({ id: draftId, text: "We can start Monday.", threadId: t.salesThread, inReplyToId: t.salesMsg });
    list = (await t.owner.get(`/api/threads/${t.salesThread}/drafts`)).body.drafts;
    expect(list[0]).toMatchObject({ mine: true, author: expect.objectContaining({ name: "Olive Owner" }) });
    // Max hears once: a notification, and a note in his live view of the thread.
    const notes = (await t.max.get("/api/notifications")).body;
    const items = (notes.notifications ?? notes.items ?? notes.data ?? []) as { type: string; title: string }[];
    expect(items.filter((n) => n.type === "draft_taken_over").map((n) => n.title)).toEqual(["Olive took over your draft on Re: Quote for the fit out".replace("Olive", "Olive Owner")]);
    const live = (await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab1", state: "replying" })).body;
    expect(live.notes).toEqual([expect.objectContaining({ type: "draft_taken_over", draftId, byName: "Olive Owner" })]);
    expect((await t.owner.get(`/api/threads/${t.salesThread}/presence`)).body.notes).toEqual([]);
    // Max's open Compose saves: refused with a clear message, nothing overwritten.
    const stale = await t.max.post("/api/mail/drafts", { id: draftId, mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote for the fit out", text: "Mine!", inReplyToId: t.salesMsg });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("draft_taken_over");
    expect(stale.body.error.message).toContain("Olive Owner took over this draft");
    // Taking over again is a no op; Max can take it back, which notifies Olive.
    expect((await t.owner.post(`/api/threads/drafts/${draftId}/take-over`)).status).toBe(200);
    expect((await t.max.post(`/api/threads/drafts/${draftId}/take-over`)).status).toBe(200);
  });

  it("two saves of the same draft can't clobber each other, and a reopened draft stays in its thread", async () => {
    const t = await team();
    const first = (await t.owner.post("/api/mail/drafts", { mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote", text: "v1", inReplyToId: t.salesMsg })).body.id as string;
    const second = await t.owner.post("/api/mail/drafts", { id: first, mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote", text: "v2" });
    expect(second.status).toBe(201);
    // Saved again without inReplyToId (reopened from Drafts): still the same thread.
    expect((await t.owner.get(`/api/threads/${t.salesThread}/drafts`)).body.drafts.map((d: { id: string; snippet: string }) => [d.id, d.snippet])).toEqual([[second.body.id, "v2"]]);
    // A window still holding the first id: 409, not a second copy.
    const stale = await t.owner.post("/api/mail/drafts", { id: first, mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote", text: "old window" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("draft_changed");
    expect((await t.owner.get(`/api/threads/${t.salesThread}/drafts`)).body.drafts).toHaveLength(1);
  });

  it("scopes drafts to mailboxes the caller can open and refuses other workspaces", async () => {
    const t = await team();
    const ceoDraft = (await t.owner.post("/api/mail/drafts", { mailboxId: t.ceoId, to: ["board@example.com"], subject: "Re: Board pack", text: "secret", inReplyToId: t.ceoMsg })).body.id as string;
    expect((await t.owner.get(`/api/threads/${t.ceoThread}/drafts`)).body.drafts).toHaveLength(1);
    expect((await t.max.post(`/api/threads/drafts/${ceoDraft}/take-over`)).status).toBe(404);
    expect((await t.outsider.post(`/api/threads/drafts/${ceoDraft}/take-over`)).status).toBe(404);
    // A member can't hang a draft on a message in a mailbox they can't open.
    const sneaky = await t.max.post("/api/mail/drafts", { mailboxId: t.salesId, to: ["x@example.com"], subject: "Re", text: "hi", inReplyToId: t.ceoMsg });
    expect(sneaky.status).toBe(201);
    expect((await t.owner.get(`/api/threads/${t.ceoThread}/drafts`)).body.drafts).toHaveLength(1);
  });
});

describe("REST and MCP", () => {
  async function api(key: string, method: string, path: string) {
    const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost" } });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function mcpFor(key: string) {
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const client = new McpClient({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    return client;
  }
  const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

  it("reads presence and drafts with a read key; take over needs a full key", async () => {
    const t = await team();
    const draftId = (await t.max.post("/api/mail/drafts", { mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote", text: "Draft", inReplyToId: t.salesMsg })).body.id as string;
    await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab1", state: "replying" });
    const ro = (await t.owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const full = (await t.owner.post("/api/developer/keys", { name: "Writer" })).body.secret as string;
    const p = await api(ro, "GET", `/threads/${t.salesThread}/presence`);
    expect(p.status).toBe(200);
    expect(p.body.replying).toEqual(["Max Member"]);
    expect((await api(ro, "GET", `/threads/${t.salesThread}/drafts`)).body.drafts).toHaveLength(1);
    const roTake = await api(ro, "POST", `/drafts/${draftId}/take-over`);
    expect(roTake.status, JSON.stringify(roTake.body)).toBe(403);
    expect((await api(ro, "GET", `/threads/nope/presence`)).status).toBe(404);
    const other = (await t.outsider.post("/api/developer/keys", { name: "Other" })).body.secret as string;
    expect((await api(other, "GET", `/threads/${t.salesThread}/drafts`)).status).toBe(404);
    expect((await api(other, "POST", `/drafts/${draftId}/take-over`)).status).toBe(404);
    const took = await api(full, "POST", `/drafts/${draftId}/take-over`);
    expect(took.status).toBe(200);
    expect(took.body.previousAuthorId).toBeTruthy();
  });

  it("MCP: get_thread_presence and list_thread_drafts read; take_over_draft refuses a read key", async () => {
    const t = await team();
    const draftId = (await t.max.post("/api/mail/drafts", { mailboxId: t.salesId, to: ["buyer@example.com"], subject: "Re: Quote", text: "Draft", inReplyToId: t.salesMsg })).body.id as string;
    await t.max.post(`/api/threads/${t.salesThread}/presence`, { clientId: "maxtab1", state: "viewing" });
    const ro = await mcpFor((await t.owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret);
    const names = (await ro.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["get_thread_presence", "list_thread_drafts", "take_over_draft"]));
    const pres = data(await ro.callTool({ name: "get_thread_presence", arguments: { threadId: t.salesThread } }));
    expect(pres.people).toEqual([expect.objectContaining({ name: "Max Member", state: "viewing" })]);
    expect(data(await ro.callTool({ name: "list_thread_drafts", arguments: { threadId: t.salesThread } })).drafts[0].id).toBe(draftId);
    const denied = await ro.callTool({ name: "take_over_draft", arguments: { draftId } });
    expect(denied.isError).toBe(true);
    const rw = await mcpFor((await t.owner.post("/api/developer/keys", { name: "Writer" })).body.secret);
    const took = data(await rw.callTool({ name: "take_over_draft", arguments: { draftId } }));
    expect(took.draft.id).toBe(draftId);
    const missing = await rw.callTool({ name: "get_thread_presence", arguments: { threadId: t.ceoThread + "x" } });
    expect(missing.isError).toBe(true);
  });
});
