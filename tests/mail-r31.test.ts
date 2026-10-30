import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { isBulkMail, isRobotSender, readStatusLine, SplitCreate } from "@/shared/mail-splits";
import { isScannerAgent, withPixel } from "@/server/services/mail/read-status";
import { lit } from "@/server/services/mail/splits";

/** R31: split inbox (Important, Other, custom splits) and read status on sent mail. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
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

async function inbound(subject: string, from: { address: string; name: string }, headers: Record<string, string> = {}, extra: { inReplyTo?: string; attachments?: { filename: string; contentType: string; content: Uint8Array }[] } = {}) {
  const messageId = `<${Math.random().toString(36).slice(2)}@example.com>`;
  await deliverInbound(ctx.deps, {
    envelopeFrom: from.address, rcptTo: "hello@acme.io", sizeBytes: 300, via: "test",
    email: { messageId, from, to: [{ address: "hello@acme.io" }], cc: [], subject, text: "Hi", date: new Date(now.getTime() + Math.random() * 1000), attachments: extra.attachments ?? [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers, inReplyTo: extra.inReplyTo },
  });
  return messageId;
}
const subjects = async (split: string) =>
  ((await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&split=${split}`)).body.messages as { subject: string }[]).map((m) => m.subject).sort();

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
  mailboxId = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id;
});

describe("bulk and robot senders", () => {
  it("reads bulk headers and robot local parts", () => {
    expect(isBulkMail({ "list-unsubscribe": "<mailto:u@x.com>" }, "a@x.com")).toBe(true);
    expect(isBulkMail({ "list-id": "news.x.com" }, "a@x.com")).toBe(true);
    expect(isBulkMail({ precedence: "Bulk" }, "a@x.com")).toBe(true);
    expect(isBulkMail({ "auto-submitted": "auto-generated" }, "a@x.com")).toBe(true);
    expect(isBulkMail({ "auto-submitted": "no" }, "a@x.com")).toBe(false);
    expect(isBulkMail({}, "noreply@x.com")).toBe(true);
    expect(isBulkMail({}, "grace@x.com")).toBe(false);
    expect(isRobotSender("no-reply+abc@x.com")).toBe(true);
    expect(isRobotSender("notifications@github.com")).toBe(true);
    expect(isRobotSender("newsom@x.com")).toBe(false);
  });

  it("validates rules and escapes literals", () => {
    expect(SplitCreate.safeParse({ name: "VIP", rules: [{ field: "fromDomain", value: "" }] }).success).toBe(false);
    expect(SplitCreate.safeParse({ name: "Team", rules: [{ field: "fromTeammate" }] }).success).toBe(true);
    expect(SplitCreate.safeParse({ name: "x", rules: [] }).success).toBe(false);
    // A quote can't leave the literal; control characters are dropped.
    expect((lit("o'brien\u0000') or 1=1 --").queryChunks[0] as { value: string[] }).value[0]).toBe("'o''brien'') or 1=1 --'");
  });
});

describe("split inbox", () => {
  it("puts people (and verified first time senders, R32) in Important and bulk mail in Other, and custom splits take their mail out of both", async () => {
    // A teammate, a person we wrote to, a reply in our thread, a verified first time sender: Important. A newsletter, a robot, a bulk pitch: Other.
    await inbound("From teammate", { address: "owner@acme.io", name: "Olive" });
    await owner.post("/api/mail/send", { mailboxId, to: ["grace@example.com"], subject: "Lunch?", text: "Free Friday?" });
    await inbound("Grace writes", { address: "grace@example.com", name: "Grace" });
    await inbound("Weekly news", { address: "grace@example.com", name: "Grace" }, { "list-unsubscribe": "<https://x.com/u>" });
    await inbound("Your receipt", { address: "noreply@shop.com", name: "Shop" });
    // R32: a pitch sent through a mailing tool (List-Unsubscribe) is bulk and stays in Other.
    await inbound("Cold pitch", { address: "sam@vendor.io", name: "Sam" }, { "list-unsubscribe": "<https://vendor.io/u>" });
    // R32: a person writing for the first time, SPF and DKIM passing, not bulk: Important.
    await inbound("Hello from Ana", { address: "ana@studio.io", name: "Ana" });
    await inbound("Invite: standup", { address: "cal@vendor.io", name: "Calendar" }, {}, { attachments: [{ filename: "invite.ics", contentType: "text/calendar", content: new TextEncoder().encode("BEGIN:VCALENDAR") }] });

    expect(await subjects("important")).toEqual(["From teammate", "Grace writes", "Hello from Ana", "Invite: standup"]);
    expect(await subjects("other")).toEqual(["Cold pitch", "Weekly news", "Your receipt"]);

    // Live preview, then a custom split by domain.
    expect((await owner.post("/api/mail/splits/preview", { rules: [{ field: "fromDomain", value: "vendor.io" }], mailboxId })).body.threads).toBe(2);
    const vendors = (await owner.post("/api/mail/splits", { name: "Vendors", rules: [{ field: "fromDomain", value: "@vendor.io" }] }));
    expect(vendors.status).toBe(201);
    expect(await subjects(vendors.body.split.id)).toEqual(["Cold pitch", "Invite: standup"]);
    expect(await subjects("other")).toEqual(["Weekly news", "Your receipt"]);

    // A calendar split ordered first; it does not leave Important, so it only shows its own matches.
    const cal = (await owner.post("/api/mail/splits", { name: "Calendar", rules: [{ field: "calendarInvite" }], leavesImportant: false })).body.split;
    expect(await subjects(cal.id)).toEqual(["Invite: standup"]);
    const re = await owner.post("/api/mail/splits/reorder", { ids: [cal.id, vendors.body.split.id] });
    expect(re.body.splits.map((s: { name: string }) => s.name)).toEqual(["Calendar", "Vendors"]);

    // Tabs carry unread counts and come in order.
    const tabs = (await owner.get(`/api/mail/splits?mailboxId=${mailboxId}`)).body.tabs as { name: string; unread: number }[];
    expect(tabs.map((t) => `${t.name}:${t.unread}`)).toEqual(["Important:3", "Other:2", "Calendar:1", "Vendors:2"]);

    // Rename clashes and reserved names are refused; delete gives the mail back to Other.
    expect((await owner.patch(`/api/mail/splits/${cal.id}`, { name: "vendors" })).status).toBe(409);
    expect((await owner.post("/api/mail/splits", { name: "Other", rules: [{ field: "subjectContains", value: "x" }] })).status).toBe(400);
    expect((await owner.patch(`/api/mail/splits/${vendors.body.split.id}`, { rules: [{ field: "subjectContains", value: "pitch" }] })).body.split.rules[0].field).toBe("subjectContains");
    expect(await subjects("other")).toEqual(["Weekly news", "Your receipt"]);
    expect((await owner.del(`/api/mail/splits/${vendors.body.split.id}`)).body.deleted).toBe(true);
    expect(await subjects("other")).toEqual(["Cold pitch", "Weekly news", "Your receipt"]);
    expect((await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox&split=spl_nope`)).status).toBe(404);
  });

  it("splits are each person's own, and work in v1 and MCP", async () => {
    await inbound("Cold pitch", { address: "sam@vendor.io", name: "Sam" });
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const made = await api(key, "POST", "/mail/splits", { name: "Vendors", rules: [{ field: "fromDomain", value: "vendor.io" }] });
    expect(made.status).toBe(201);
    expect((await api(key, "POST", "/mail/splits/preview", { rules: [{ field: "fromContains", value: "sam" }] })).body.threads).toBe(1);
    const listed = await api(key, "GET", `/messages?mailboxId=${mailboxId}&folder=inbox&split=${made.body.split.id}`);
    expect(listed.body.data.map((m: { subject: string }) => m.subject)).toEqual(["Cold pitch"]);
    expect((await api(key, "GET", `/messages?mailboxId=${mailboxId}&folder=inbox&split=other`)).body.data).toHaveLength(0);

    const mcp = await mcpFor(key);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    for (const n of ["mail_split_list", "mail_split_create", "mail_split_update", "mail_split_delete", "mail_read_status"]) expect(names).toContain(n);
    const list = data(await mcp.callTool({ name: "mail_split_list", arguments: { mailboxId } }));
    expect(list.tabs.map((t: { name: string }) => t.name)).toEqual(["Important", "Other", "Vendors"]);
    const created = data(await mcp.callTool({ name: "mail_split_create", arguments: { name: "Pitches", rules: [{ field: "subjectContains", value: "pitch" }], leavesImportant: false } }));
    const upd = data(await mcp.callTool({ name: "mail_split_update", arguments: { splitId: created.split.id, name: "Sales pitches" } }));
    expect(upd.split.name).toBe("Sales pitches");
    const threads = data(await mcp.callTool({ name: "list_threads", arguments: { split: created.split.id } }));
    expect(threads.data).toHaveLength(1);
    expect(data(await mcp.callTool({ name: "mail_split_delete", arguments: { splitId: created.split.id } })).deleted).toBe(true);
    await mcp.close();

    // Another member sees none of the owner's splits.
    const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "admin", mailboxIds: [] });
    const maya = new Client(ctx.app);
    await maya.signup("maya@acme.io", "Maya", "");
    await maya.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    expect((await maya.get("/api/mail/splits")).body.splits).toHaveLength(0);
    expect((await maya.get(`/api/mail/splits/${made.body.split.id}`)).status).toBe(404);
  });
});

describe("read status", () => {
  it("is off by default, and when on, the outside copy carries the image and Sent shows opens", async () => {
    // Off: no image, nothing tracked.
    expect((await owner.get("/api/mail/prefs")).body.prefs.readStatus).toBe(false);
    await owner.post("/api/mail/send", { mailboxId, to: ["grace@example.com"], subject: "Untracked", text: "Hi" });
    expect(ctx.outbound.sent.at(-1)!.html ?? "").not.toContain("/r/o/");

    expect((await owner.patch("/api/mail/prefs", { readStatus: true })).body.prefs.readStatus).toBe(true);
    const sent = await owner.post("/api/mail/send", { mailboxId, to: ["grace@example.com"], subject: "Tracked", text: "Hello <there>" });
    const out = ctx.outbound.sent.at(-1)!;
    const m = (out.html ?? "").match(/\/r\/o\/([A-Za-z0-9_-]+)\.gif/);
    expect(m).toBeTruthy();
    expect(out.html).toContain("Hello &lt;there&gt;");
    const url = `/r/o/${m![1]}.gif`;
    const ua = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };

    // The stored Sent copy has no image.
    const sentList = (await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=sent`)).body.messages as { id: string; subject: string; readStatus: { tracked: boolean; opens: number } }[];
    const tracked = sentList.find((x) => x.subject === "Tracked")!;
    expect(tracked.id).toBe(sent.body.messageId);
    expect(tracked.readStatus).toMatchObject({ tracked: true, opens: 0 });
    expect(sentList.find((x) => x.subject === "Untracked")!.readStatus.tracked).toBe(false);

    // Too soon (a scanner on delivery), then a scanner, then a person; a second open inside a minute is not written.
    let r = await ctx.app.request(url, { headers: ua });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/gif");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await r.arrayBuffer()).slice(0, 3)).toEqual(new TextEncoder().encode("GIF"));
    now = new Date(now.getTime() + 30_000);
    await ctx.app.request(url, { headers: { "user-agent": "Mimecast URL scanner" } });
    await ctx.app.request(url, { headers: ua });
    await ctx.app.request(url, { headers: ua });
    let status = (await owner.get(`/api/mail/read-status/${tracked.id}`)).body.readStatus;
    expect(status.opens).toBe(1);
    now = new Date(now.getTime() + 61_000);
    await ctx.app.request(url, { headers: ua });
    status = (await owner.get(`/api/mail/read-status/${tracked.id}`)).body.readStatus;
    expect(status.opens).toBe(2);
    expect(status.lastOpenAt).toBe(now.toISOString());

    // Unknown tokens still answer the image; the thread view carries the status under the sent message.
    r = await ctx.app.request("/r/o/AAAAAAAAAAAAAAAAAAAAAAAA.gif", { headers: ua });
    expect(r.status).toBe(200);
    const thread = (await owner.get(`/api/mail/messages/${tracked.id}`)).body.thread as { readStatus?: { opens: number } }[];
    expect(thread[0].readStatus?.opens).toBe(2);

    // v1 and MCP.
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    expect((await api(key, "GET", `/mail/messages/${tracked.id}/read-status`)).body.readStatus.opens).toBe(2);
    expect((await api(key, "GET", "/mail/prefs")).body.prefs.readStatus).toBe(true);
    const mcp = await mcpFor(key);
    expect(data(await mcp.callTool({ name: "mail_read_status", arguments: { messageId: tracked.id } })).opens).toBe(2);
    await mcp.close();
  });

  it("helpers: scanner agents, pixel placement and the status line", () => {
    expect(isScannerAgent(undefined)).toBe(true);
    expect(isScannerAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isScannerAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15")).toBe(false);
    expect(withPixel("<html><body><p>Hi</p></body></html>", "Hi", "https://x/r/o/t.gif")).toMatch(/<p>Hi<\/p><img src="https:\/\/x\/r\/o\/t.gif"[^>]*\/><\/body>/);
    expect(withPixel(undefined, "a\nb", "https://x/r/o/t.gif")).toContain("white-space:pre-wrap");
    const fmt = () => "3:14 PM";
    expect(readStatusLine({ tracked: false, opens: 0, firstOpenAt: null, lastOpenAt: null }, fmt)).toBeNull();
    expect(readStatusLine({ tracked: true, opens: 0, firstOpenAt: null, lastOpenAt: null }, fmt)).toBe("Not opened yet");
    expect(readStatusLine({ tracked: true, opens: 2, firstOpenAt: "x", lastOpenAt: "y" }, fmt)).toBe("Opened 2x, last 3:14 PM");
  });
});
