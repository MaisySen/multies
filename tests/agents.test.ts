import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { extractCodes, extractLinks, latestText } from "@/server/services/agents/parse";
import { expireApprovals } from "@/server/services/agents";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let wsKey: string;
let domainId: string;

async function api(key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function verify() {
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}

async function inbound(to: string, subject: string, text: string, extra: Record<string, unknown> = {}) {
  return deliverInbound(ctx.deps, {
    envelopeFrom: "grace@example.com", rcptTo: to, sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: "grace@example.com", name: "Grace" }, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {}, ...extra },
  });
}

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify();
  wsKey = (await c.post("/api/developer/keys", { name: "Agents" })).body.secret;
});

describe("parsing for agents", () => {
  it("strips quoted history and finds codes and links", () => {
    expect(latestText("Sounds good, Friday works.\n\nOn Mon, 1 Jan 2026 at 10:00, Bob <b@x.io> wrote:\n> Can we meet?\n")).toBe("Sounds good, Friday works.");
    expect(extractCodes("Your verification code is 482913. It expires in 10 minutes.")).toEqual(["482913"]);
    expect(extractCodes("Use code 123 456 to sign in")).toEqual(["123456"]);
    expect(extractCodes("Invoice 2026 is attached, total 4500 dollars")).toEqual([]);
    expect(extractLinks("Confirm at https://app.example.com/confirm?t=abc.", '<a href="https://example.com/x?a=1&amp;b=2">x</a>')).toEqual(["https://app.example.com/confirm?t=abc", "https://example.com/x?a=1&b=2"]);
  });
});

describe("agent inboxes over the API", () => {
  it("creates an agent inbox and its key in one call, lists it and deletes it", async () => {
    const made = await api(wsKey, "POST", "/agents", { name: "Invoice bot", localPart: "invoices" });
    expect(made.status).toBe(201);
    expect(made.body.agent).toMatchObject({ name: "Invoice bot", address: "invoices@acme.io", approvalMode: "always", sendCapDaily: 100, status: "active" });
    expect(made.body.apiKey.secret).toMatch(/^mm_live_/);
    const list = await api(wsKey, "GET", "/agents");
    expect(list.body.data.map((a: { address: string }) => a.address)).toEqual(["invoices@acme.io"]);
    // The agent's own key sees only itself.
    expect((await api(made.body.apiKey.secret, "GET", "/agents")).body.data).toHaveLength(1);
    // Agent inboxes don't count as mailboxes.
    expect((await c.get("/api/billing")).body.usage).toMatchObject({ mailboxes: 0, agentInboxes: 1 });
    // An agent key posts in chat under the agent's name, not the key's (dogfood finding F2).
    const channel = (await api(wsKey, "POST", "/chat/channels", { name: "agents-test" })).body;
    const channelId = channel.channel?.id ?? channel.id;
    const post = await api(made.body.apiKey.secret, "POST", `/chat/channels/${channelId}/messages`, { body: "Invoices are in." });
    expect(post.status).toBe(201);
    const read = await api(wsKey, "GET", `/chat/channels/${channelId}/messages`);
    expect(JSON.stringify(read.body)).toContain("Invoice bot");
    expect(JSON.stringify(read.body)).not.toContain("API key");
    const del = await api(wsKey, "DELETE", `/agents/${made.body.agent.id}`);
    expect(del.body).toEqual({ id: made.body.agent.id, deleted: true });
    expect((await api(wsKey, "GET", "/agents")).body.data).toEqual([]);
    expect((await api(made.body.apiKey.secret, "GET", "/agents")).status).toBe(401);
  });

  it("keeps agent keys inside their agent", async () => {
    const a = (await api(wsKey, "POST", "/agents", { name: "A" })).body;
    const b = (await api(wsKey, "POST", "/agents", { name: "B" })).body;
    const key = a.apiKey.secret;
    expect((await api(key, "GET", "/domains")).body.error.code).toBe("agent_key_scope");
    expect((await api(key, "POST", "/messages", { mailboxId: a.agent.inboxId, to: ["x@example.com"] })).status).toBe(403);
    expect((await api(key, "POST", "/agents", { name: "C" })).body.error.code).toBe("agent_key_scope");
    expect((await api(key, "GET", `/agents/${b.agent.id}/threads`)).status).toBe(403);
    expect((await api(key, "POST", `/agents/${b.agent.id}/send`, { to: ["x@example.com"], subject: "s", text: "t" })).status).toBe(403);
    await inbound(b.agent.address, "For B only", "secret");
    const thread = (await api(wsKey, "GET", `/agents/${b.agent.id}/threads`)).body.data[0];
    expect((await api(key, "GET", `/threads/${thread.id}`)).status).toBe(404);
    expect((await api(key, "GET", "/search?q=secret")).body.data).toEqual([]);
  });

  it("enforces the free plan's 3 agent inboxes and lifts it with the add-on", async () => {
    for (const n of ["one", "two", "three"]) expect((await api(wsKey, "POST", "/agents", { name: n })).status).toBe(201);
    const fourth = await api(wsKey, "POST", "/agents", { name: "four" });
    expect(fourth.status).toBe(403);
    expect(fourth.body.error).toMatchObject({ code: "plan_limit" });
    expect(fourth.body.error.message).toContain("A$1 a month");
    await c.post("/api/billing/addons", { addons: { agent_inbox: 1 } });
    expect((await api(wsKey, "POST", "/agents", { name: "four" })).status).toBe(201);
  });

  it("delivers inbound mail as parsed JSON: event, webhook payload and thread", async () => {
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Signup bot", localPart: "signups" })).body;
    await inbound("signups@acme.io", "Your sign in code", "Hi,\n\nYour verification code is 482913.\nOr open https://example.com/verify?t=1\n\nThanks");
    const events = (await api(apiKey.secret, "GET", "/events")).body.data;
    const received = events.find((e: { type: string }) => e.type === "message.received");
    expect(received.data).toMatchObject({ subject: "Your sign in code", codes: ["482913"], links: ["https://example.com/verify?t=1"] });
    const threads = (await api(apiKey.secret, "GET", `/agents/${agent.id}/threads`)).body;
    expect(threads.data).toHaveLength(1);
    expect(threads.data[0]).toMatchObject({ subject: "Your sign in code", unreadCount: 1, messageCount: 1 });
    const t = (await api(apiKey.secret, "GET", `/threads/${threads.data[0].id}`)).body;
    expect(t.messages[0]).toMatchObject({ direction: "inbound", codes: ["482913"], sentBy: { type: "external" } });
    // Polling from the last id returns nothing new.
    expect((await api(apiKey.secret, "GET", `/events?after=${events.at(-1).id}`)).body.data).toEqual([]);
    // The read is in the audit log, attributed to the agent.
    const audit = (await api(wsKey, "GET", `/agents/${agent.id}/audit`)).body.data.map((e: { action: string; actorEmail: string }) => `${e.action} ${e.actorEmail}`);
    expect(audit).toContain("agent.message_read agent:signups@acme.io");
  });

  it("streams events over SSE and resumes from Last-Event-ID", async () => {
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Streamer" })).body;
    await inbound(agent.address, "First", "one");
    await inbound(agent.address, "Second", "two");
    const res = await ctx.app.request(`/api/v1/agents/${agent.id}/events/stream?timeout=0&from=start`, { headers: { authorization: `Bearer ${apiKey.secret}`, host: "localhost" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: ready");
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(body.match(/event: message.received/g)).toHaveLength(2);
    const resumed = await (await ctx.app.request(`/api/v1/agents/${agent.id}/events/stream?timeout=0`, { headers: { authorization: `Bearer ${apiKey.secret}`, host: "localhost", "last-event-id": String(ids.at(-1)! - 1) } })).text();
    expect(resumed.match(/event: message.received/g)).toHaveLength(1);
    expect(resumed).toContain("Second");
  });

  it("queues sends for approval by default, then sends as the agent once a person approves", async () => {
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Support bot", localPart: "support-bot" })).body;
    await inbound(agent.address, "Where is my order?", "Hi, order 1182 hasn't arrived.");
    const thread = (await api(apiKey.secret, "GET", `/agents/${agent.id}/threads`)).body.data[0];
    const reply = await api(apiKey.secret, "POST", `/agents/${agent.id}/threads/${thread.id}/reply`, { text: "Sorry about that. It ships today." });
    expect(reply.status).toBe(202);
    expect(reply.body.status).toBe("pending_approval");
    expect(reply.body.approval).toMatchObject({ to: ["grace@example.com"], subject: "Re: Where is my order?", threadId: thread.id, status: "pending" });
    expect(ctx.outbound.sent.filter((m) => m.subject.startsWith("Re: Where"))).toHaveLength(0);

    // An agent can't approve itself.
    expect((await api(apiKey.secret, "POST", `/approvals/${reply.body.approval.id}/approve`, {})).status).toBe(403);
    // The thread shows the waiting reply; a person approves it in the app.
    expect((await c.get(`/api/agents/threads/${thread.id}`)).body.pendingApprovals).toHaveLength(1);
    const queue = (await c.get("/api/approvals?status=pending")).body.approvals;
    expect(queue).toHaveLength(1);
    const ok = await c.post(`/api/approvals/${queue[0].id}/approve`, { text: "Sorry about that. It ships today, tracking to follow." });
    expect(ok.status).toBe(200);
    expect(ok.body.approval.status).toBe("sent");
    const out = ctx.outbound.sent.find((m) => m.subject === "Re: Where is my order?")!;
    expect(out.text).toContain("tracking to follow");
    expect(out.from.address).toBe(agent.address);
    // Approving twice is refused.
    expect((await c.post(`/api/approvals/${queue[0].id}/approve`, {})).status).toBe(409);
    // The sent message is labelled as the agent's in the shared view.
    const t = (await c.get(`/api/agents/threads/${thread.id}`)).body;
    expect(t.messages.at(-1).sentBy).toMatchObject({ type: "agent", agentId: agent.id, name: "Support bot" });
    const shared = (await c.get("/api/agents/threads")).body.data[0];
    expect(shared.lastSentBy).toMatchObject({ type: "agent", name: "Support bot" });
    const audit = (await c.get(`/api/agents/${agent.id}/audit`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["agent.created", "agent.key_created", "agent.send_queued", "approval.approved"]));
    const events = (await api(apiKey.secret, "GET", "/events")).body.data.map((e: { type: string }) => e.type);
    expect(events).toEqual(expect.arrayContaining(["approval.requested", "approval.decided"]));
  });

  it("rejects, expires, and applies approval modes, allow lists and the daily cap", async () => {
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Outreach", approvalMode: "external", sendCapDaily: 2, allowedRecipients: ["@example.com", "team@acme.io"] })).body;
    await c.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" });
    // Internal mail skips approval in "external" mode.
    const internal = await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["team@acme.io"], subject: "FYI", text: "Inside" });
    expect(internal.status).toBe(200);
    expect(internal.body.status).toBe("sent");
    const outside = await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["lead@example.com"], subject: "Hello", text: "Outside" });
    expect(outside.status).toBe(202);
    const rejected = await c.post(`/api/approvals/${outside.body.approval.id}/reject`, { note: "Too pushy" });
    expect(rejected.body.approval).toMatchObject({ status: "rejected", note: "Too pushy", decidedBy: "owner@acme.io" });
    // Not on the allow list.
    const blocked = await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["ceo@other.org"], subject: "x", text: "x" });
    expect(blocked.body.error.code).toBe("recipient_not_allowed");
    // Cap of 2 a day. A rejected request doesn't count, so one more goes, then the cap holds.
    expect((await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["team@acme.io"], subject: "again", text: "x" })).status).toBe(200);
    const capped = await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["team@acme.io"], subject: "third", text: "x" });
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("agent_send_cap");
    const audit = (await c.get(`/api/agents/${agent.id}/audit`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit.filter((a: string) => a === "agent.send_blocked")).toHaveLength(2);

    // "never": sends go straight out; pausing stops everything.
    await api(wsKey, "PATCH", `/agents/${agent.id}`, { approvalMode: "never", sendCapDaily: 10 });
    expect((await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["lead@example.com"], subject: "Now", text: "x" })).body.status).toBe("sent");
    await api(wsKey, "PATCH", `/agents/${agent.id}`, { status: "paused" });
    expect((await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["lead@example.com"], subject: "x", text: "x" })).body.error.code).toBe("agent_paused");

    // Requests nobody decides expire after a week.
    await api(wsKey, "PATCH", `/agents/${agent.id}`, { status: "active", approvalMode: "always" });
    await api(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["lead@example.com"], subject: "Later", text: "x" });
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 8 * 86400_000);
    expect(await expireApprovals(ctx.deps)).toBe(1);
    ctx.deps.now = real;
  });

  it("lets an agent work a shared mailbox beside people", async () => {
    const team = (await c.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox;
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Triage", mailboxIds: [team.id], approvalMode: "never" })).body;
    expect(agent.mailboxIds).toEqual([agent.inboxId, team.id]);
    await inbound("support@acme.io", "Refund please", "I'd like a refund for invoice 77.");
    const threads = (await api(apiKey.secret, "GET", `/agents/${agent.id}/threads`)).body.data;
    expect(threads[0]).toMatchObject({ mailboxId: team.id, subject: "Refund please" });
    const sent = await api(apiKey.secret, "POST", `/agents/${agent.id}/threads/${threads[0].id}/reply`, { text: "On it. Refund processed." });
    expect(sent.body.status).toBe("sent");
    // A person sees the agent's reply in the support thread, labelled.
    const view = (await c.get(`/api/mail/messages?mailboxId=${team.id}&folder=sent`)).body;
    expect(view.messages[0]).toMatchObject({ subject: "Re: Refund please", sentByAgentId: agent.id });
    expect((await c.get("/api/agents/threads")).body.data.find((t: { id: string }) => t.id === threads[0].id).agentsInvolved).toEqual([{ agentId: agent.id, name: "Triage" }]);
  });
});
