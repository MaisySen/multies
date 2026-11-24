import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { aliases, deliveries, domains, mailboxes, messages } from "@/server/db/schema";
import { ACCOUNT_MAIL_NOT_SENT_TO_AGENT, sendSystemEmail } from "@/server/services/system-mail";
import { deliverInbound } from "@/server/services/mail/delivery";
import { NOT_FORWARDED_TO_AGENT, NOT_FORWARDED_TO_OTHER_WORKSPACE } from "@/server/services/agents/platform-mail";
import { recordEvent } from "@/server/services/agents";
import { makeSnippet } from "@/server/services/mail/mime";

/**
 * AIS1 (audit of 11 Nov 2026, row 32): Multies' own mail (invites, "Confirm your email", password resets, guest
 * invites) never hands its codes or links to an agent or an app. Outside senders' codes keep working: that is what
 * the agent feed is for.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let wsKey: string;
let agentKey: string;
let agentId: string;
let domainId: string;
let orgId: string;
let inboxId: string;
const SECRET = "Zq7mK2pX9wTr4LbN8cVd";
const CODE = "573918";

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

async function verify(id: string) {
  const { body } = await owner.get(`/api/domains/${id}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await owner.post(`/api/domains/${id}/verify`)).body.domain.status).toBe("verified");
}

/** Multies' own mail into the agent's inbox, carrying a one-time code and a link with a secret. */
async function platformMail(to = "agent@acme.io") {
  const r = await sendSystemEmail(ctx.deps, {
    to, subject: "You're invited to Launch", template: "guest-invite",
    text: `Olive invited you to the project "Launch" on Multies. Your sign-in code is ${CODE}.`,
    action: { label: "Open the project", url: `http://localhost/g/${SECRET}` },
  });
  expect(r).toMatchObject({ delivered: true, via: "internal" });
  return (await ctx.db.select().from(messages).where(eq(messages.subject, "You're invited to Launch")).get())!;
}

async function outside(to: string, from: string, subject: string, text: string) {
  return deliverInbound(ctx.deps, {
    envelopeFrom: from, rcptTo: to, sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: from, name: "Sender" }, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  await verify(domainId);
  wsKey = (await owner.post("/api/developer/keys", { name: "Setup" })).body.secret;
  const made = await api(wsKey, "POST", "/agents", { name: "Agent", localPart: "agent" });
  agentKey = made.body.apiKey.secret;
  agentId = made.body.agent.id;
  inboxId = made.body.agent.inboxId;
});

describe("AIS1 row 32: the platform's own mail never gives an agent its codes or links", () => {
  it("the stored message carries a marker only the platform sets, and a preview with no link or code", async () => {
    const m = await platformMail();
    expect(JSON.parse(m.authResults!)).toMatchObject({ platform: "system" });
    expect(m.snippet).not.toContain(SECRET);
    expect(m.snippet).not.toContain(CODE);
    // People still read the whole message in the app.
    expect(m.text).toContain(SECRET);
  });

  it("the agent feed, poll, thread, message, search and MCP tools get no code, link or text", async () => {
    const m = await platformMail();
    const events = await api(agentKey, "GET", `/events?after=0`);
    const received = events.body.data?.filter?.((e: { type: string }) => e.type === "message.received") ?? events.body.events?.filter((e: { type: string }) => e.type === "message.received");
    expect(received).toHaveLength(1);
    expect(received[0].data).toMatchObject({ codes: [], links: [], withheld: "platform_mail", subject: "You're invited to Launch" });
    const reads = [
      events,
      await api(agentKey, "GET", `/threads/${m.threadId}`),
      await api(wsKey, "GET", `/threads/${m.threadId}`),
      await api(wsKey, "GET", `/messages/${m.id}`),
      await api(wsKey, "GET", `/messages?mailboxId=${m.mailboxId}`),
      await api(agentKey, "GET", `/agents/${agentId}/threads`),
    ];
    for (const r of reads) {
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
      expect(JSON.stringify(r.body)).not.toContain(CODE);
    }
    expect((await api(wsKey, "GET", `/messages/${m.id}`)).body.withheld).toBe("platform_mail");
    // A search can't be used to read the secret one letter at a time.
    expect((await api(agentKey, "GET", `/search?q=${SECRET.slice(0, 6)}`)).body.data).toEqual([]);
    expect((await api(wsKey, "GET", `/messages?search=${SECRET.slice(0, 6)}`)).body.data).toEqual([]);
    // MCP: wait_for_email, read_thread and search.
    const mcp = await mcpFor(agentKey);
    const waited = data(await mcp.callTool({ name: "wait_for_email", arguments: { agentId, timeoutSeconds: 0, cursor: 0 } }));
    expect(waited.messages).toHaveLength(1);
    const thread = data(await mcp.callTool({ name: "read_thread", arguments: { threadId: m.threadId } }));
    const found = data(await mcp.callTool({ name: "search", arguments: { query: SECRET.slice(0, 6) } }));
    for (const out of [waited, thread, found]) {
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(JSON.stringify(out)).not.toContain(CODE);
    }
    expect(thread.messages[0]).toMatchObject({ withheld: "platform_mail", codes: [], links: [], html: null });
    // The owner, signed in to the app, reads it all.
    const mine = await owner.get(`/api/mail/messages/${m.id}`);
    expect(JSON.stringify(mine.body)).toContain(SECRET);
  });

  it("a task made from it copies no text, and an agent reading the task gets none", async () => {
    const m = await platformMail();
    const mcp = await mcpFor(agentKey);
    const made = data(await mcp.callTool({ name: "create_task", arguments: { messageId: m.id } }));
    expect(made.task.notes).not.toContain(SECRET);
    const read = data(await mcp.callTool({ name: "get_task", arguments: { id: made.task.id } }));
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(JSON.stringify(read)).not.toContain(CODE);
  });

  it("mail that can take over an account is never delivered into an agent's inbox", async () => {
    const r = await sendSystemEmail(ctx.deps, { to: "agent@acme.io", accountSecurity: true, subject: "Reset your Multies password", text: "Reset it.", action: { label: "Choose a new password", url: `http://localhost/reset/${SECRET}` } });
    expect(r).toMatchObject({ delivered: false, via: "none" });
    expect(r.detail).toContain("AI agent's inbox");
    expect(await sendSystemEmail(ctx.deps, { to: "Agent+Signup@acme.io", accountSecurity: true, subject: "Reset your Multies password", text: "Reset it." })).toMatchObject({ delivered: false, via: "none" });
    expect(await ctx.db.select().from(messages).where(eq(messages.subject, "Reset your Multies password")).get()).toBeUndefined();
    expect(ctx.outbound.sent.filter((m) => m.subject === "Reset your Multies password")).toEqual([]);
    // Review 2: the agent's workspace sees why it never arrived, by address, in its delivery log.
    const log = await ctx.db.select().from(deliveries).where(eq(deliveries.orgId, orgId));
    expect(log.filter((d) => d.status === "rejected").map((d) => [d.toAddress, d.subject, d.detail]).sort()).toEqual([
      ["agent+signup@acme.io", "Reset your Multies password", ACCOUNT_MAIL_NOT_SENT_TO_AGENT],
      ["agent@acme.io", "Reset your Multies password", ACCOUNT_MAIL_NOT_SENT_TO_AGENT],
    ]);
  });

  it("outside senders' codes and links keep working, a forged Multies sender is hidden, a bounce notice is readable", async () => {
    await outside("agent@acme.io", "noreply@service.example", "Your Acme code", `Your verification code is ${CODE}. Or open https://service.example/v/${SECRET}`);
    await outside("agent@acme.io", ctx.deps.config.systemFrom.address, "Forged", `Your verification code is 112233. https://evil.example/x`);
    await deliverInbound(ctx.deps, {
      envelopeFrom: ctx.deps.config.systemFrom.address, rcptTo: "agent@acme.io", sizeBytes: 100, via: "internal", platformMail: "notice",
      email: { messageId: "<ndr.1@localhost>", from: { address: ctx.deps.config.systemFrom.address, name: "Mail Delivery" }, to: [{ address: "agent@acme.io" }], cc: [], subject: "Undeliverable: Hello", text: "Your message could not be delivered to: bob@nowhere.example", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const events = await api(agentKey, "GET", `/events?after=0`);
    const list = (events.body.data ?? events.body.events) as { type: string; data: { subject: string; codes: string[]; links: string[]; latestText: string; withheld?: string } }[];
    const by = (s: string) => list.find((e) => e.data.subject === s)!.data;
    expect(by("Your Acme code")).toMatchObject({ codes: [CODE], links: [`https://service.example/v/${SECRET}`] });
    expect(by("Your Acme code").withheld).toBeUndefined();
    expect(by("Forged")).toMatchObject({ codes: [], links: [], withheld: "platform_mail" });
    expect(by("Undeliverable: Hello").latestText).toContain("could not be delivered");
    expect(by("Undeliverable: Hello").withheld).toBeUndefined();
  });

  it("an outside sender can't set the marker through its own Authentication-Results", async () => {
    await deliverInbound(ctx.deps, {
      envelopeFrom: "x@service.example", rcptTo: "agent@acme.io", sizeBytes: 100, via: "test",
      email: { messageId: "<x.1@service.example>", from: { address: "x@service.example", name: "X" }, to: [{ address: "agent@acme.io" }], cc: [], subject: "Marked by hand", text: `code ${CODE}`, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass", platform: "notice" } as never, headers: {} },
    });
    const row = (await ctx.db.select().from(messages).where(eq(messages.subject, "Marked by hand")).get())!;
    expect(JSON.parse(row.authResults!).platform).toBeUndefined();
  });
});

/** A password reset, as Better Auth sends it (accountSecurity), to an address with a mailbox of its own. */
async function resetMail(to: string) {
  const r = await sendSystemEmail(ctx.deps, {
    to, accountSecurity: true, subject: "Reset your Multies password", template: "reset-password",
    text: "Someone asked to reset the password for your Multies account.",
    action: { label: "Choose a new password", url: `http://localhost/reset-password/${SECRET}` },
  });
  expect(r).toMatchObject({ delivered: true, via: "internal" });
}

describe("AIS1 row 32 (review): a forward never hands the platform's own mail to an agent", () => {
  it("a person's mail rule doesn't forward it to the agent, and its forward elsewhere keeps the mark", async () => {
    const hello = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id as string;
    const team = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
    // An ordinary setup in an AI mail product: "forward my mail to my agent", and to a teammate.
    const rule = await owner.post("/api/mail/rules", { name: "Forward", mailboxId: hello, conditions: [{ field: "subject", value: "password" }], actions: [{ kind: "forward", to: "agent@acme.io" }, { kind: "forward", to: "team@acme.io" }] });
    expect(rule.status).toBe(201);
    await resetMail("hello@acme.io");
    // Nothing the agent can read carries the link.
    const events = await api(agentKey, "GET", "/events?after=0");
    expect(JSON.stringify(events.body)).not.toContain(SECRET);
    const mcp = await mcpFor(agentKey);
    expect(JSON.stringify(data(await mcp.callTool({ name: "wait_for_email", arguments: { agentId, timeoutSeconds: 0, cursor: 0 } })))).not.toContain(SECRET);
    // The rule's run log says why the agent got nothing; the teammate's forward went.
    const runs = (await owner.get(`/api/mail/rules/${rule.body.rule.id}/runs`)).body.runs as { status: string; steps: { action: string; ok: boolean; detail?: string }[] }[];
    expect(runs[0].steps).toEqual([{ action: "forward", ok: false, detail: NOT_FORWARDED_TO_AGENT }, { action: "forward", ok: true, detail: "team@acme.io" }]);
    // The Sent copy in Hello and the copy in Team keep the mark: a workspace key gets neither's text.
    const copies = await ctx.db.select().from(messages).where(eq(messages.subject, "Fwd: Reset your Multies password"));
    expect(copies.map((m) => m.mailboxId).sort()).toEqual([hello, team].sort());
    for (const m of copies) {
      expect(JSON.parse(m.authResults!)).toMatchObject({ platform: "system" });
      expect(m.snippet).not.toContain(SECRET);
      const read = await api(wsKey, "GET", `/messages/${m.id}`);
      expect(read.body.withheld).toBe("platform_mail");
      expect(JSON.stringify(read.body)).not.toContain(SECRET);
    }
    // People still read it.
    const inTeam = copies.find((m) => m.mailboxId === team)!;
    expect(JSON.stringify((await owner.get(`/api/mail/messages/${inTeam.id}`)).body)).toContain(SECRET);
  });

  it("Round 2 (PR 23): a person's Forward from Compose keeps the mark and is refused to an AI agent", async () => {
    const hello = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id as string;
    const team = (await owner.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).body.mailbox.id as string;
    await resetMail("hello@acme.io");
    const src = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, hello)).all()).find((m) => /password/i.test(m.subject))!;
    const body = (to: string[]) => ({ mailboxId: hello, to, subject: `Fwd: ${src.subject}`, text: `---------- Forwarded message ----------\n${src.text}`, forwardOfId: src.id });
    const refused = await owner.post("/api/mail/send", body(["agent@acme.io"]));
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("platform_mail_to_agent");
    expect(await ctx.db.select().from(messages).where(eq(messages.subject, `Fwd: ${src.subject}`))).toEqual([]);
    expect((await owner.post("/api/mail/send", body(["team@acme.io"]))).status).toBe(201);
    const copies = await ctx.db.select().from(messages).where(eq(messages.subject, `Fwd: ${src.subject}`));
    expect(copies.map((m) => m.mailboxId).sort()).toEqual([hello, team].sort());
    for (const m of copies) {
      expect(JSON.parse(m.authResults!)).toMatchObject({ platform: "system" });
      const read = await api(wsKey, "GET", `/messages/${m.id}`);
      expect(read.body.withheld).toBe("platform_mail");
      expect(JSON.stringify(read.body)).not.toContain(SECRET);
    }
    // An ordinary message's forward is ordinary mail.
    await outside("hello@acme.io", "friend@example.com", "Lunch", "Friday?");
    const lunch = (await ctx.db.select().from(messages).where(eq(messages.subject, "Lunch")).get())!;
    expect((await owner.post("/api/mail/send", { mailboxId: hello, to: ["agent@acme.io"], subject: "Fwd: Lunch", text: "Friday?", forwardOfId: lunch.id })).status).toBe(201);
  });

  it("Round 2 (PR 23): search everything and contact_timeline never match or show its preview for a key", async () => {
    const hello = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id as string;
    await resetMail("hello@acme.io");
    const row = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, hello)).all()).find((m) => /password/i.test(m.subject))!;
    // A preview stored before the AIS1 fix still holds the link.
    await ctx.db.update(messages).set({ snippet: `Someone asked to reset it: http://localhost/reset-password/${SECRET}` }).where(eq(messages.id, row.id));
    const viaKey = await api(wsKey, "GET", `/search/everything?q=${encodeURIComponent("asked to reset")}&types=mail`);
    expect(viaKey.status).toBe(200);
    expect(JSON.stringify(viaKey.body)).not.toContain(row.id);
    const bySubject = await api(wsKey, "GET", `/search/everything?q=${encodeURIComponent("Reset your Multies")}&types=mail`);
    expect(JSON.stringify(bySubject.body)).toContain(row.id);
    expect(JSON.stringify(bySubject.body)).not.toContain(SECRET);
    // A person still finds it by its text.
    expect(JSON.stringify((await owner.get(`/api/search?q=${encodeURIComponent("asked to reset")}&types=mail`)).body)).toContain(row.id);
    // contact_timeline over MCP: the thread is there, its preview has no link.
    expect((await api(wsKey, "POST", "/contacts", { email: "hello@acme.io", name: "Hello" })).status).toBeLessThan(300);
    const mcp = await mcpFor(wsKey);
    const tl = JSON.stringify(data(await mcp.callTool({ name: "contact_timeline", arguments: { id: "hello@acme.io" } })));
    await mcp.close();
    expect(tl).toContain(row.threadId);
    expect(tl).not.toContain(SECRET);
  });

  it("Wave 2 review X8: with SEARCH_R98 on, search everything doesn't match or show its preview for a key either", async () => {
    (ctx.deps.config as { searchR98?: boolean }).searchR98 = true;
    const hello = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id as string;
    await resetMail("hello@acme.io");
    const row = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, hello)).all()).find((m) => /password/i.test(m.subject))!;
    await ctx.db.update(messages).set({ snippet: `Someone asked to reset it: http://localhost/reset-password/${SECRET}` }).where(eq(messages.id, row.id));
    for (const key of [wsKey, agentKey]) {
      const viaKey = await api(key, "GET", `/search/everything?q=${encodeURIComponent("asked to reset")}&types=mail`);
      expect(viaKey.status).toBe(200);
      expect(JSON.stringify(viaKey.body)).not.toContain(row.id);
    }
    const bySubject = await api(wsKey, "GET", `/search/everything?q=${encodeURIComponent("Reset your Multies")}&types=mail`);
    expect(JSON.stringify(bySubject.body)).toContain(row.id);
    expect(JSON.stringify(bySubject.body)).not.toContain(SECRET);
    expect(JSON.stringify(bySubject.body)).not.toContain("asked to reset");
    // A person in the app still finds it by its text.
    expect(JSON.stringify((await owner.get(`/api/search?q=${encodeURIComponent("asked to reset")}&types=mail`)).body)).toContain(row.id);
  });

  it("an alias never forwards it out to another workspace's agent; a plain outside address still gets it", async () => {
    const other = new Client(ctx.app);
    await other.signup("boss@beta.test", "Beta Boss");
    const betaDomain = (await other.post("/api/domains", { name: "beta.test" })).body.domain.id as string;
    const { body } = await other.get(`/api/domains/${betaDomain}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    expect((await other.post(`/api/domains/${betaDomain}/verify`)).body.domain.status).toBe("verified");
    const betaKey = (await other.post("/api/developer/keys", { name: "Setup" })).body.secret as string;
    expect((await api(betaKey, "POST", "/agents", { name: "Bot", localPart: "bot" })).status).toBe(201);
    await ctx.db.insert(aliases).values({ id: "als_fwd", orgId, domainId, localPart: "fwd", address: "fwd@acme.io", destinations: JSON.stringify(["bot@beta.test", "me@home.example"]) });
    // What the provider hands back for system mail that went out to the alias (no mark, the system sender's From).
    const sys = ctx.deps.config.systemFrom.address;
    const r = await deliverInbound(ctx.deps, {
      envelopeFrom: sys, rcptTo: "fwd@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<sys.fwd@localhost>", from: { address: sys, name: "Multies" }, to: [{ address: "fwd@acme.io" }], cc: [], subject: "Reset your Multies password", text: `Choose a new password: http://localhost/reset-password/${SECRET}`, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    expect(r.forwardedTo).toEqual(["me@home.example"]);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("bot@beta.test"))).toEqual([]);
    const log = await ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, "bot@beta.test"));
    expect(log.map((d) => [d.status, d.detail])).toEqual([["rejected", NOT_FORWARDED_TO_AGENT]]);
    // Outside senders' mail through the same alias still reaches the agent.
    await outside("fwd@acme.io", "noreply@service.example", "Your code", `Your code is ${CODE}`);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("bot@beta.test")).map((m) => m.subject)).toEqual(["Your code"]);
  });

  it("Round 2 (PR 23): an alias never forwards it to a person's address another workspace hosts", async () => {
    const other = new Client(ctx.app);
    await other.signup("boss@gamma.test", "Gamma Boss");
    const gDomain = (await other.post("/api/domains", { name: "gamma.test" })).body.domain.id as string;
    const { body } = await other.get(`/api/domains/${gDomain}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    expect((await other.post(`/api/domains/${gDomain}/verify`)).body.domain.status).toBe("verified");
    expect((await other.post("/api/mailboxes", { domainId: gDomain, localPart: "inbox", displayName: "Inbox" })).status).toBe(201);
    await ctx.db.insert(aliases).values({ id: "als_fwd2", orgId, domainId, localPart: "fwd2", address: "fwd2@acme.io", destinations: JSON.stringify(["inbox@gamma.test", "me@home.example"]) });
    const sys = ctx.deps.config.systemFrom.address;
    const r = await deliverInbound(ctx.deps, {
      envelopeFrom: sys, rcptTo: "fwd2@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<sys.fwd2@localhost>", from: { address: sys, name: "Multies" }, to: [{ address: "fwd2@acme.io" }], cc: [], subject: "Reset your Multies password", text: `Choose a new password: http://localhost/reset-password/${SECRET}`, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    expect(r.forwardedTo).toEqual(["me@home.example"]);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("inbox@gamma.test"))).toEqual([]);
    const log = await ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, "inbox@gamma.test"));
    expect(log.map((d) => [d.status, d.detail])).toEqual([["rejected", NOT_FORWARDED_TO_OTHER_WORKSPACE]]);
    // Outside senders' mail through the same alias still goes there.
    await outside("fwd2@acme.io", "noreply@service.example", "Your code", `Your code is ${CODE}`);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("inbox@gamma.test")).map((m) => m.subject)).toEqual(["Your code"]);
  });

  it("Wave 2 review X10: nor to an address connected as a mailbox in another workspace", async () => {
    const other = new Client(ctx.app);
    await other.signup("boss@delta.test", "Delta Boss");
    const otherOrg = (await other.get("/api/account/me")).body.organization.id as string;
    const { ensurePlatformDomain } = await import("@/server/services/free-address");
    const { CONNECTED_DOMAIN } = await import("@/server/services/connect");
    const connected = await ensurePlatformDomain(ctx.deps, CONNECTED_DOMAIN);
    // A Gmail address another workspace connected: its mail is copied there, readable by that workspace's keys.
    await ctx.db.insert(mailboxes).values({ id: "mbx_x10conn", orgId: otherOrg, domainId: connected.id, localPart: "delta.boss", address: "delta.boss@gmail.example", displayName: "Delta", quotaMb: 100, personal: true });
    await ctx.db.insert(aliases).values({ id: "als_fwd3", orgId, domainId, localPart: "fwd3", address: "fwd3@acme.io", destinations: JSON.stringify(["delta.boss@gmail.example", "me@home.example"]) });
    const sys = ctx.deps.config.systemFrom.address;
    const r = await deliverInbound(ctx.deps, {
      envelopeFrom: sys, rcptTo: "fwd3@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<sys.fwd3@localhost>", from: { address: sys, name: "Multies" }, to: [{ address: "fwd3@acme.io" }], cc: [], subject: "Reset your Multies password", text: `Choose a new password: http://localhost/reset-password/${SECRET}`, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    expect(r.forwardedTo).toEqual(["me@home.example"]);
    const log = await ctx.db.select().from(deliveries).where(eq(deliveries.toAddress, "delta.boss@gmail.example"));
    expect(log.map((d) => [d.status, d.detail])).toEqual([["rejected", NOT_FORWARDED_TO_OTHER_WORKSPACE]]);
    // Outside senders' mail through the same alias still goes there.
    await outside("fwd3@acme.io", "noreply@service.example", "Your code", `Your code is ${CODE}`);
    expect(ctx.outbound.sent.filter((m) => m.to.includes("delta.boss@gmail.example")).map((m) => m.subject)).toEqual(["Your code"]);
  });

  it("a person whose own sign in alias also copies their agent still gets a password reset; the agent's copy is withheld", async () => {
    // Review 2: PRIV1b P37 lets a member make an alias at their own sign in address. Olive sends her mail to her Gmail
    // and her AI, an ordinary setup. Her reset goes out as usual (it was skipped, with no trace, before).
    const alias = await owner.post("/api/aliases", { domainId, localPart: "owner", destinations: ["owner@home.example", "agent@acme.io"] });
    expect(alias.status).toBe(201);
    ctx.outbound.sent.length = 0;
    const anon = new Client(ctx.app);
    const rq = await anon.call("POST", "/api/auth/request-password-reset", { email: "owner@acme.io", redirectTo: "/reset-password" }, { "cf-connecting-ip": "203.0.113.91" });
    expect(rq.status).toBe(200);
    const sent = ctx.outbound.sent.filter((m) => m.to.includes("owner@acme.io") && /reset/i.test(m.subject));
    expect(sent).toHaveLength(1);
    const link = /https?:\/\/\S+/.exec(sent[0].text ?? "")?.[0] ?? "";
    const token = link.split("?")[0].split("/").pop() ?? "";
    expect(token.length).toBeGreaterThan(10);
    expect((await ctx.db.select().from(deliveries).where(eq(deliveries.orgId, orgId))).filter((d) => d.status === "rejected")).toEqual([]);
    // The provider hands it back to owner@acme.io: the Gmail copy goes out, the agent's copy has no text, link or code.
    const sys = ctx.deps.config.systemFrom.address;
    const back = await deliverInbound(ctx.deps, {
      envelopeFrom: sys, rcptTo: "owner@acme.io", sizeBytes: 600, via: "test",
      email: { messageId: "<sys.reset@localhost>", from: { address: sys, name: "Multies" }, to: [{ address: "owner@acme.io" }], cc: [], subject: sent[0].subject, text: sent[0].text ?? "", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    expect(back.forwardedTo).toEqual(["owner@home.example"]);
    const agentCopy = (await ctx.db.select().from(messages).where(eq(messages.mailboxId, inboxId))).find((m) => m.subject === sent[0].subject)!;
    expect(agentCopy).toBeTruthy();
    expect(JSON.stringify((await api(agentKey, "GET", "/events?after=0")).body)).not.toContain(token);
    expect(JSON.stringify((await api(agentKey, "GET", `/threads/${agentCopy.threadId}`)).body)).not.toContain(token);
  });

  it("account mail to an address an agent catch-all gets goes out too, and the agent's copy is withheld", async () => {
    await ctx.db.update(domains).set({ catchAllMailboxId: inboxId }).where(eq(domains.id, domainId));
    const r = await sendSystemEmail(ctx.deps, { to: "sam@acme.io", accountSecurity: true, subject: "Reset your Multies password", text: "Reset it.", action: { label: "Choose a new password", url: `http://localhost/reset/${SECRET}` } });
    expect(r.via).toBe("none"); // the log transport: it went to the provider, not into the agent's inbox
    expect(ctx.outbound.sent.filter((m) => m.to.includes("sam@acme.io")).map((m) => m.subject)).toEqual(["Reset your Multies password"]);
    expect(await ctx.db.select().from(messages).where(eq(messages.mailboxId, inboxId))).toEqual([]);
    const sys = ctx.deps.config.systemFrom.address;
    await deliverInbound(ctx.deps, {
      envelopeFrom: sys, rcptTo: "sam@acme.io", sizeBytes: 300, via: "test",
      email: { messageId: "<sys.sam@localhost>", from: { address: sys, name: "Multies" }, to: [{ address: "sam@acme.io" }], cc: [], subject: "Reset your Multies password", text: `Choose a new password: http://localhost/reset/${SECRET}`, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    expect((await ctx.db.select().from(messages).where(eq(messages.mailboxId, inboxId))).map((m) => m.subject)).toEqual(["Reset your Multies password"]);
    expect(JSON.stringify((await api(agentKey, "GET", "/events?after=0")).body)).not.toContain(SECRET);
  });
});

describe("AIS1 row 32 (review): a bulk job's search is no oracle on the platform's own mail", () => {
  it("an agent key's search counts none of it, on v1 and MCP; a person's search in the app finds it", async () => {
    const m = await platformMail();
    const job = (id: string, q: string) => ({ client_job_id: id, action: "read", scope: { mailboxId: m.mailboxId, q }, max_received_at: new Date(Date.now() + 60_000).toISOString() });
    // Before the fix an agent key counted 1 for a right guess and 0 for a wrong one: the secret, a letter at a time.
    const hit = await api(agentKey, "POST", "/mail/bulk-jobs", job("oracle_hit_0001", SECRET.slice(0, 8)));
    const miss = await api(agentKey, "POST", "/mail/bulk-jobs", job("oracle_miss_001", `${SECRET.slice(0, 7)}#`));
    expect([hit.status, miss.status]).toEqual([200, 200]);
    expect({ hit: hit.body.total, miss: miss.body.total }).toEqual({ hit: 0, miss: 0 });
    expect((await api(wsKey, "POST", "/mail/bulk-jobs", job("oracle_code_001", CODE))).body.total).toBe(0);
    const mcp = await mcpFor(agentKey);
    const viaMcp = data(await mcp.callTool({ name: "mail_bulk_job", arguments: { job_id: "oracle_mcp_0001", action: "read", mailbox_id: m.mailboxId, query: SECRET.slice(0, 8) } }));
    expect(viaMcp.total).toBe(0);
    // Without a search, the folder's own count still includes it; a person searching in the app finds it.
    expect((await api(agentKey, "POST", "/mail/bulk-jobs", { ...job("folder_all_0001", ""), scope: { mailboxId: m.mailboxId, folder: "inbox" } })).body.total).toBe(1);
    expect((await owner.post("/api/mail/bulk-jobs/preview", { scope: { mailboxId: m.mailboxId, q: SECRET.slice(0, 8) }, max_received_at: new Date(Date.now() + 60_000).toISOString() })).body.total).toBe(1);
  });
});

describe("AIS1 row 32 (review): a workspace export a key or an app starts withholds the platform's own mail", () => {
  async function mailIn(downloadUrl: string) {
    const u = new URL(downloadUrl, "http://localhost");
    const dl = await ctx.app.request(u.pathname + u.search, { headers: { host: "localhost" } });
    expect(dl.status).toBe(200);
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()));
    return Object.entries(files).filter(([name]) => name.startsWith("mail/")).map(([, bytes]) => strFromU8(bytes)).join(" ");
  }

  it("a workspace key's export has the reset's subject and sender only, in the JSON and the mbox", async () => {
    await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" });
    await resetMail("hello@acme.io");
    await outside("hello@acme.io", "noreply@service.example", "Your Acme code", `Your code is ${CODE}`);
    const ex = await api(wsKey, "POST", "/data-moves/exports", {});
    expect(ex.status).toBeLessThan(300);
    const mail = await mailIn(ex.body.downloadUrl);
    expect(mail).toContain("Reset your Multies password");
    expect(mail).not.toContain(SECRET);
    expect(mail).toContain("platform_mail");
    // Everyone else's mail is exported whole.
    expect(mail).toContain(CODE);
  }, 60_000);

  it("an owner's export from the app keeps it whole", async () => {
    await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" });
    await resetMail("hello@acme.io");
    const ex = await owner.post("/api/data-moves/exports", {});
    expect(ex.status).toBe(200);
    const mail = await mailIn(ex.body.downloadPath);
    expect(mail).toContain(`reset-password/${SECRET}`);
  }, 60_000);
});

describe("AIS1 row 32 (review): what the agent already held from before the fix is withheld when read", () => {
  it("a feed event written before the fix for a confirmation is served withheld, on the feed and wait_for_email", async () => {
    // The live agent's event log: the feed event written for "Confirm your email" before the fix (its message is gone).
    await recordEvent(ctx.deps, orgId, agentId, "message.received", {
      messageId: "msg_old", threadId: "thr_old", mailboxId: inboxId, from: { address: ctx.deps.config.systemFrom.address, name: "Multies" },
      subject: "Confirm your email for Multies", latestText: `Confirm: http://localhost/verify-email?token=${SECRET}`, codes: [], links: [`http://localhost/verify-email?token=${SECRET}`],
    });
    const feed = await api(agentKey, "GET", "/events?after=0");
    const mcp = await mcpFor(agentKey);
    const waited = data(await mcp.callTool({ name: "wait_for_email", arguments: { agentId, timeoutSeconds: 0, cursor: 0 } }));
    expect(JSON.stringify(feed.body)).toContain("Confirm your email for Multies");
    expect(JSON.stringify(feed.body)).not.toContain(SECRET);
    expect(JSON.stringify(waited)).not.toContain(SECRET);
    expect(waited.messages[0]).toMatchObject({ subject: "Confirm your email for Multies", links: [], withheld: "platform_mail" });
  });

  it("a preview stored before the fix loses its link in list_threads, the agent's threads and search_everything", async () => {
    const m = await platformMail();
    // A row stored before the fix: no platform mark, and the preview cut from the text (link included).
    await ctx.db.update(messages).set({ authResults: JSON.stringify({ spf: "pass", dkim: "pass", dmarc: "pass" }), snippet: makeSnippet(m.text) }).where(eq(messages.id, m.id));
    expect((await ctx.db.select().from(messages).where(eq(messages.id, m.id)).get())!.snippet).toContain(SECRET.slice(0, 12));
    const mcp = await mcpFor(agentKey);
    const reads = [
      data(await mcp.callTool({ name: "list_threads", arguments: { agentId } })),
      (await api(agentKey, "GET", `/agents/${agentId}/threads`)).body,
      data(await mcp.callTool({ name: "search_everything", arguments: { q: "invited" } })),
    ];
    for (const r of reads) expect(JSON.stringify(r)).toContain("invited to Launch");
    for (const r of reads) expect(JSON.stringify(r)).not.toContain(SECRET.slice(0, 12));
  });
});
