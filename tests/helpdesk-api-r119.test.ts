import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { mailSnippets } from "@/server/db/schema";
import { WIDGET_JS } from "@/server/routes/widget-script";

/** R119: helpdesk mode and the website chat through the API. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
let ownerId: string;

async function verify(domainId: string) {
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await owner.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
}
async function inbound(subject: string, text: string, from = "grace@example.com") {
  return deliverInbound(ctx.deps, {
    envelopeFrom: from, rcptTo: "support@acme.io", sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: from, name: "Grace Hopper" }, to: [{ address: "support@acme.io" }], cc: [], subject, text, date: new Date(Date.now() + 1000), attachments: [], authResults: {} },
  } as Parameters<typeof deliverInbound>[1]);
}
async function member() {
  const invite = await owner.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
  const mate = new Client(ctx.app);
  await mate.signup("mate@acme.io", "Mia Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return mate;
}
const W = (key: string, path: string, init: { method?: string; origin?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  ctx.app.request(`/api/widget/${key}${path}`, {
    method: init.method ?? "GET",
    headers: { host: "localhost", ...(init.origin !== undefined ? { origin: init.origin } : { origin: "https://www.shop.com" }), ...(init.token ? { "x-visitor-token": init.token } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const me = await owner.get("/api/account/me");
  ownerId = me.body.user?.id ?? me.body.id;
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify(domainId);
  mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Acme support" })).body.mailbox.id;
});

describe("helpdesk mode", () => {
  it("is off until an admin turns it on; then new mail becomes a ticket", async () => {
    const off = await owner.get("/api/helpdesk/tickets");
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ on: false, tickets: [] });
    expect((await owner.patch("/api/helpdesk/settings", { mailboxIds: [mailboxId] })).status).toBe(200);
    await inbound("My order never came", "Hi, order 1234 has not arrived.");
    const r = await owner.get("/api/helpdesk/tickets");
    expect(r.body.on).toBe(true);
    expect(r.body.tickets).toHaveLength(1);
    expect(r.body.tickets[0]).toMatchObject({ number: 1001, kind: "mail", status: "open", priority: "normal", subject: "My order never came", requester: { email: "grace@example.com" } });
    expect(["ok", "warn"]).toContain(r.body.tickets[0].sla.first.level);
    expect(r.body.counts).toMatchObject({ open: 1, unassigned: 1, mine: 0 });
    const byRef = await owner.get(`/api/helpdesk/tickets/by-ref?kind=mail&ref=${encodeURIComponent(r.body.tickets[0].refId)}`);
    expect(byRef.body.ticket.id).toBe(r.body.tickets[0].id);
  });

  it("changes status, priority and assignee, mirrored on the thread", async () => {
    await owner.patch("/api/helpdesk/settings", { mailboxIds: [mailboxId] });
    await inbound("Refund please", "I want a refund.");
    const t = (await owner.get("/api/helpdesk/tickets")).body.tickets[0];
    const p = await owner.patch(`/api/helpdesk/tickets/${t.id}`, { priority: "urgent", assigneeUserId: ownerId });
    expect(p.status).toBe(200);
    expect(p.body.ticket).toMatchObject({ priority: "urgent", assignee: { id: ownerId } });
    expect((await owner.get("/api/helpdesk/tickets?view=mine")).body.tickets).toHaveLength(1);
    const pend = await owner.patch(`/api/helpdesk/tickets/${t.id}`, { status: "pending" });
    expect(pend.body.ticket.sla.resolve.level).toBe("paused");
    const state = await owner.get(`/api/agents/threads?view=waiting`);
    expect(state.status).toBe(200);
    expect(state.body.data.some((x: { id: string }) => x.id === t.refId)).toBe(true);
    // a new customer mail opens it again
    await new Promise((r) => setTimeout(r, 5));
    ctx.deps.now = () => new Date(Date.now() + 20_000);
    await inbound("Re: Refund please", "Any news?");
    const again = (await owner.get("/api/helpdesk/tickets")).body.tickets.find((x: { id: string }) => x.id === t.id);
    expect(again.status).toBe("open");
    expect((await owner.patch(`/api/helpdesk/tickets/${t.id}`, { assigneeUserId: "nobody-here" })).status).toBe(400);
  });

  it("macros run their steps; the reply comes back for the composer", async () => {
    await owner.patch("/api/helpdesk/settings", { mailboxIds: [mailboxId] });
    await inbound("Where is my parcel", "Tracking?");
    const t = (await owner.get("/api/helpdesk/tickets")).body.tickets[0];
    const m = await owner.post("/api/helpdesk/macros", { name: "Ask for order number", steps: [
      { type: "assign", to: "me" }, { type: "priority", priority: "high" }, { type: "note", text: "Asked for the number" },
      { type: "reply", text: "Could you send your order number?" }, { type: "status", status: "pending" },
    ] });
    expect(m.status).toBe(201);
    const run = await owner.post(`/api/helpdesk/tickets/${t.id}/macros/${m.body.macro.id}`);
    expect(run.status).toBe(200);
    expect(run.body.ticket).toMatchObject({ status: "pending", priority: "high", assignee: { id: ownerId } });
    expect(run.body.reply).toBe("Could you send your order number?");
    expect((await owner.post("/api/helpdesk/macros", { name: "Empty", steps: [] })).status).toBe(422);
  });

  it("members work tickets but cannot change settings or macros", async () => {
    await owner.patch("/api/helpdesk/settings", { mailboxIds: [mailboxId] });
    const mate = await member();
    expect((await mate.get("/api/helpdesk/tickets")).status).toBe(200);
    expect((await mate.get("/api/helpdesk/settings")).body.canManage).toBe(false);
    expect((await mate.patch("/api/helpdesk/settings", { chats: true })).status).toBe(403);
    expect((await mate.post("/api/helpdesk/macros", { name: "x", steps: [{ type: "status", status: "solved" }] })).status).toBe(403);
  });

  it("solving with the survey on mails a one tap survey; a real tap records it", async () => {
    await owner.patch("/api/helpdesk/settings", { mailboxIds: [mailboxId], csat: { on: true } });
    await inbound("Login broken", "Cannot sign in");
    const t = (await owner.get("/api/helpdesk/tickets")).body.tickets[0];
    expect((await owner.patch(`/api/helpdesk/tickets/${t.id}`, { status: "solved" })).status).toBe(200);
    const sent = JSON.stringify(ctx.outbound);
    const token = sent.match(/\/csat\/([A-Za-z0-9_-]{20,64})/)?.[1];
    expect(token).toBeTruthy();
    // a mail scanner opening the link does not count
    const scan = await ctx.app.request(`/csat/${token}?r=great`, { headers: { host: "localhost" } });
    expect(scan.status).toBe(200);
    expect((await owner.get(`/api/helpdesk/tickets/${t.id}`)).body.ticket.csat).toBeNull();
    const tap = await ctx.app.request(`/csat/${token}?r=great`, { headers: { host: "localhost", "sec-fetch-user": "?1", "sec-fetch-mode": "navigate" } });
    expect(tap.status).toBe(200);
    expect((await owner.get(`/api/helpdesk/tickets/${t.id}`)).body.ticket.csat).toMatchObject({ rating: "great" });
    expect((await ctx.app.request(`/csat/${"x".repeat(30)}`, { headers: { host: "localhost" } })).status).toBe(404);
  });

  it("is switched off by the HELPDESK flag", async () => {
    ctx = await makeTestApp({ HELPDESK: "off" });
    owner = new Client(ctx.app);
    await owner.signup("o2@acme.io");
    expect((await owner.get("/api/helpdesk/tickets")).status).toBe(404);
    expect((await ctx.app.request("/widget.js", { headers: { host: "localhost" } })).headers.get("cross-origin-resource-policy")).not.toBe("cross-origin");
  });
});

describe("website chat", () => {
  async function widgetOn(extra: Record<string, unknown> = {}) {
    const r = await owner.patch("/api/helpdesk/settings", { hours: { always: true, timezone: "Australia/Sydney", days: [null, null, null, null, null, null, null], holidays: [] }, widget: { on: true, domains: ["https://Shop.com/"], mailboxId, askEmail: "after", botAnswers: true, title: "Chat with us", greeting: "Hi", color: null, ...extra } });
    expect(r.status).toBe(200);
    return r.body.widgetKey as string;
  }

  it("needs a domain, normalises it and gives the snippet", async () => {
    expect((await owner.patch("/api/helpdesk/settings", { widget: { on: true, domains: [] } })).status).toBe(400);
    expect((await owner.patch("/api/helpdesk/settings", { widget: { on: true, domains: ["not a site"] } })).status).toBe(400);
    const key = await widgetOn();
    const s = await owner.get("/api/helpdesk/settings");
    expect(s.body.settings.widget.domains).toEqual(["shop.com"]);
    expect(s.body.snippet).toContain(`data-key="${key}"`);
  });

  it("answers only the allowed domains, with CORS for them", async () => {
    const key = await widgetOn();
    expect((await W(key, "/config", { origin: "https://evil.io" })).status).toBe(403);
    expect((await W(key, "/config", { origin: "" })).status).toBe(403);
    const ok = await W(key, "/config");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://www.shop.com");
    expect(await ok.json()).toMatchObject({ title: "Chat with us", online: true, askEmail: "after" });
    const pre = await W(key, "/chats", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-visitor-token");
    expect((await W(key, "/chats", { method: "OPTIONS", origin: "https://evil.io" })).status).toBe(403);
    expect((await W("wnotakey12345", "/config")).status).toBe(404);
  });

  it("visitor chats, gets an automatic answer, the team replies, typing shows both ways, survey after solve", async () => {
    const orgId = (await ctx.db.all<{ id: string }>("select id from organizations limit 1" as never))[0]?.id;
    await ctx.db.insert(mailSnippets).values({ id: "snp_refund", orgId, name: "Refund policy", body: "Refunds within 30 days.", shared: true, createdBy: ownerId, createdAt: new Date(), updatedAt: new Date() } as never);
    const key = await widgetOn();
    await owner.patch("/api/helpdesk/settings", { csat: { on: true } });
    const start = await W(key, "/chats", { method: "POST", body: { text: "What is your refund policy?", name: "Vera Visitor", page: "https://www.shop.com/pricing?x=1" } });
    expect(start.status).toBe(201);
    const s = await start.json();
    expect(s.token).toBeTruthy();
    expect(s.messages.map((m: { author: string }) => m.author)).toEqual(["visitor", "bot"]);
    const list = await owner.get("/api/helpdesk/tickets");
    const t = list.body.tickets.find((x: { kind: string }) => x.kind === "web");
    expect(t).toMatchObject({ requester: { name: "Vera Visitor" }, status: "open" });
    expect((await W(key, "/chats/me/typing", { method: "POST", token: s.token })).status).toBe(200);
    expect((await owner.get(`/api/helpdesk/tickets/${t.id}/web`)).body).toMatchObject({ visitorTyping: true, visitorOnline: true, page: "https://www.shop.com/pricing" });
    await owner.post(`/api/helpdesk/tickets/${t.id}/typing`);
    expect((await (await W(key, "/chats/me", { token: s.token })).json()).agentTyping).toBe(true);
    const rep = await owner.post(`/api/helpdesk/tickets/${t.id}/web`, { text: "Hi Vera, happy to help." });
    expect(rep.status).toBe(200);
    await owner.post(`/api/helpdesk/tickets/${t.id}/web`, { text: "Internal: VIP", note: true });
    const poll = await (await W(key, "/chats/me?after=0", { token: s.token })).json();
    expect(poll.messages.map((m: { author: string }) => m.author)).toEqual(["visitor", "bot", "agent"]);
    expect(JSON.stringify(poll)).not.toContain("Internal: VIP");
    expect((await owner.get(`/api/helpdesk/tickets/${t.id}`)).body.ticket.sla.first.level).toBe("met");
    await owner.patch(`/api/helpdesk/tickets/${t.id}`, { status: "solved" });
    const after = await (await W(key, "/chats/me", { token: s.token })).json();
    expect(after.messages.some((m: { author: string; text: string }) => m.author === "system" && m.text === "csat")).toBe(true);
    expect((await W(key, "/chats/me/rating", { method: "POST", token: s.token, body: { rating: "okay" } })).status).toBe(200);
    expect((await owner.get(`/api/helpdesk/tickets/${t.id}`)).body.ticket.csat.rating).toBe("okay");
    // writing again opens it again
    await W(key, "/chats/me/messages", { method: "POST", token: s.token, body: { text: "One more thing" } });
    expect((await owner.get(`/api/helpdesk/tickets/${t.id}`)).body.ticket.status).toBe("open");
  });

  it("guards: token, honeypot, offline email, text and rate limits", async () => {
    const key = await widgetOn();
    expect((await W(key, "/chats/me", { token: "x".repeat(30) })).status).toBe(401);
    expect((await W(key, "/chats", { method: "POST", body: { text: "hi", hp: "bot" } })).status).toBe(400);
    expect((await W(key, "/chats", { method: "POST", body: { text: "  " } })).status).toBe(400);
    expect((await W(key, "/chats", { method: "POST", body: { text: "hello", offline: true } })).status).toBe(400);
    const off = await W(key, "/chats", { method: "POST", body: { text: "Call me back", offline: true, email: "lee@example.com" } });
    expect(off.status).toBe(201);
    const s = await (await W(key, "/chats", { method: "POST", body: { text: "first" } })).json();
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) limited = (await W(key, "/chats/me/messages", { method: "POST", token: s.token, body: { text: `m${i}` } })).status === 429;
    expect(limited).toBe(true);
    expect((await W(key, "/chats/me/email", { method: "POST", token: s.token, body: { email: "nope" } })).status).toBe(400);
    expect((await W(key, "/chats/me/email", { method: "POST", token: s.token, body: { email: "vera@example.com" } })).status).toBe(200);
  });

  it("serves a small script other sites can load", async () => {
    const r = await ctx.app.request("/widget.js", { headers: { host: "localhost" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(gzipSync(WIDGET_JS).length).toBeLessThan(30 * 1024);
    expect(WIDGET_JS).toBe(readFileSync(new URL("../scripts/widget-src.js", import.meta.url), "utf8"));
    expect(WIDGET_JS).not.toMatch(/https?:\/\/(?!APP)/); // no third party calls
  });
});
