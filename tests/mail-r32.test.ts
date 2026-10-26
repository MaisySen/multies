import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { storeMessage } from "@/server/services/mail/store";
import { mailboxes, messages, mailSchedules } from "@/server/db/schema";
import { BULK_MAIL_ACTIONS } from "@/server/services/mail/bulk-r32";

/** R32: bulk mail actions with their inverses (Undo), v1 and MCP, and the first time sender rule for Important. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
let orgId: string;
let now = new Date("2026-10-26T03:00:00Z");

async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
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

let tick = 0;
async function inbound(subject: string, address: string, opts: { headers?: Record<string, string>; auth?: Record<string, string> | null } = {}) {
  tick += 1;
  await deliverInbound(ctx.deps, {
    envelopeFrom: address, rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
    email: {
      messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address, name: address.split("@")[0] }, to: [{ address: "hello@acme.io" }], cc: [], subject, text: "Hi",
      date: new Date(now.getTime() + tick * 1000), attachments: [], authResults: (opts.auth === undefined ? { spf: "pass", dkim: "pass", dmarc: "pass" } : opts.auth) as never, headers: opts.headers ?? {},
    },
  });
}
const subjects = async (split: string) =>
  ((await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&split=${split}`)).body.messages as { subject: string }[]).map((m) => m.subject).sort();
const inboxIds = async () => ((await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&limit=200`)).body.messages as { id: string }[]).map((m) => m.id);

async function seed(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(await storeMessage(ctx.deps.db, {
      bodyStore: ctx.deps.bodyStore, orgId, mailboxId, folder: "inbox", from: { address: `p${i}@example.com`, name: `P${i}` },
      to: [{ address: "hello@acme.io" }], cc: [], bcc: [], subject: `Note ${i}`, text: "x", date: new Date(now.getTime() - i * 1000), isRead: false,
    }));
  }
  return ids;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  now = new Date("2026-10-26T03:00:00Z");
  ctx.deps.now = () => now;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${domainId}/verify`);
  const mb = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
  mailboxId = mb.id;
  orgId = (await ctx.deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get())!.orgId;
});

describe("first time senders (R32 product decision)", () => {
  it("a first time sender with SPF and DKIM passing lands in Important; bulk, robots and failing auth stay in Other", async () => {
    await inbound("Hello from Ana", "ana@studio.io");
    await inbound("Pitch via tool", "sam@vendor.io", { headers: { "list-unsubscribe": "<https://vendor.io/u>" } });
    await inbound("Team digest", "lists@club.org", { headers: { "list-id": "club.org", precedence: "list" } });
    await inbound("Receipt", "noreply@shop.com");
    await inbound("SPF fails", "boss@bank.com", { auth: { spf: "fail", dkim: "pass", dmarc: "none" } });
    await inbound("No DKIM", "kim@corp.io", { auth: { spf: "pass", dkim: "none", dmarc: "none" } });
    await inbound("No auth stored", "lee@corp.io", { auth: {} });
    await inbound("Softfail", "max@corp.io", { auth: { spf: "softfail", dkim: "pass", dmarc: "none" } });
    expect(await subjects("important")).toEqual(["Hello from Ana"]);
    expect(await subjects("other")).toEqual(["No DKIM", "No auth stored", "Pitch via tool", "Receipt", "SPF fails", "Softfail", "Team digest"]);
  });

  it("only the first message of a new sender counts; once you write back, everything from them is Important", async () => {
    await inbound("First note", "ana@studio.io");
    await inbound("Second note", "ana@studio.io");
    expect(await subjects("important")).toEqual(["First note"]);
    expect(await subjects("other")).toEqual(["Second note"]);
    await owner.post("/api/mail/send", { mailboxId, to: ["ana@studio.io"], subject: "Re: hi", text: "Hello" });
    expect(await subjects("important")).toEqual(["First note", "Second note"]);
  });
});

describe("bulk mail actions", () => {
  it("lists snooze and unsnooze among the actions", () => {
    for (const a of ["archive", "inbox", "read", "unread", "trash", "delete", "move", "snooze", "unsnooze"]) expect(BULK_MAIL_ACTIONS).toContain(a);
  });

  it("archives 250 messages in one call (D1 variable limit) and Undo (inbox) brings them back", async () => {
    const ids = await seed(250);
    const r = await owner.post("/api/mail/messages/bulk", { ids, action: "archive" });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(250);
    const archived = await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.folder, "archive")).all();
    expect(archived).toHaveLength(250);
    expect((await owner.post("/api/mail/messages/bulk", { ids, action: "inbox" })).body.updated).toBe(250);
    expect((await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.folder, "inbox")).all()).length).toBe(250);
    // Read then unread across 250 ids.
    expect((await owner.post("/api/mail/messages/bulk", { ids, action: "read" })).body.updated).toBe(250);
    expect((await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.isRead, true)).all()).length).toBe(250);
    expect((await owner.post("/api/mail/messages/bulk", { ids, action: "unread" })).body.updated).toBe(250);
  });

  it("refuses more than 500 ids", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `msg_${i}`);
    expect((await owner.post("/api/mail/messages/bulk", { ids, action: "read" })).status).toBe(422);
  });

  it("snoozes a selection (one snooze per thread) and unsnooze undoes it", async () => {
    const ids = await seed(30);
    const r = await owner.post("/api/mail/messages/bulk", { ids, action: "snooze", preset: "tomorrow" });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(30);
    expect(typeof r.body.dueAt).toBe("string");
    expect(await inboxIds()).toHaveLength(0);
    expect((await ctx.deps.db.select().from(mailSchedules).all()).length).toBe(30);
    // Snoozing again replaces, it does not add.
    await owner.post("/api/mail/messages/bulk", { ids: ids.slice(0, 5), action: "snooze", preset: "next_week" });
    expect((await ctx.deps.db.select().from(mailSchedules).all()).length).toBe(30);
    expect((await owner.post("/api/mail/messages/bulk", { ids, action: "unsnooze" })).body.updated).toBe(30);
    expect(await inboxIds()).toHaveLength(30);
    expect((await owner.post("/api/mail/messages/bulk", { ids, action: "snooze" })).status).toBe(400);
  });

  it("trash and delete: trash is undone by moving back, delete is forever", async () => {
    const ids = await seed(3);
    await owner.post("/api/mail/messages/bulk", { ids, action: "trash" });
    expect(await inboxIds()).toHaveLength(0);
    await owner.post("/api/mail/messages/bulk", { ids, action: "inbox" });
    expect(await inboxIds()).toHaveLength(3);
    await owner.post("/api/mail/messages/bulk", { ids: ids.slice(0, 1), action: "delete" });
    expect(await inboxIds()).toHaveLength(2);
  });

  it("works on v1 and MCP, and read only keys can't change mail", async () => {
    const ids = await seed(4);
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const v1 = await api(key, "POST", "/mail/messages/bulk", { ids: ids.slice(0, 2), action: "archive" });
    expect(v1.status).toBe(200);
    expect(v1.body.updated).toBe(2);
    expect((await api(key, "POST", "/mail/messages/bulk", { ids: [], action: "archive" })).status).toBe(422);
    const mcp = await mcpFor(key);
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("mail_bulk_action");
    const out = data(await mcp.callTool({ name: "mail_bulk_action", arguments: { ids: ids.slice(2), action: "read" } }));
    expect(out.updated).toBe(2);
    const until = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    expect(data(await mcp.callTool({ name: "mail_bulk_action", arguments: { ids: ids.slice(2), action: "snooze", until } })).updated).toBe(2);
    await mcp.close();
    expect(await inboxIds()).toHaveLength(0);

    const ro = (await owner.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    expect((await api(ro, "POST", "/mail/messages/bulk", { ids, action: "inbox" })).status).toBe(403);
  });

  it("skips ids from another workspace", async () => {
    const ids = await seed(2);
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    expect((await other.post("/api/mail/messages/bulk", { ids, action: "trash" })).body.updated).toBe(0);
    expect(await inboxIds()).toHaveLength(2);
  });
});
