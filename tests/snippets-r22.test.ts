import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { applySnippet, firstRecipient, insertAt, renderSnippet, shortcutBeforeCursor, snippetDate } from "@/shared/snippets";

/** Round 22 (R22.4b): saved replies (snippets) with variables, shared per workspace. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let maya: Client; // member with the support mailbox
let max: Client; // member with only the ceo mailbox
let adam: Client; // admin
let supportId: string;
let ceoId: string;
let threadId: string;
let ceoThreadId: string;

const tokenOf = (link: string) => link.split("/invite/")[1];
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
async function join(email: string, name: string, role: "member" | "admin", mailboxIds: string[]) {
  const inv = await owner.post("/api/team/invites", { email, role, mailboxIds });
  expect(inv.status).toBe(201);
  const u = new Client(ctx.app);
  await u.signup(email, name, "");
  expect((await u.post(`/api/invites/${tokenOf(inv.body.link)}/accept`)).status).toBe(200);
  return u;
}
async function inbound(to: string, subject: string, from: { address: string; name: string }) {
  await deliverInbound(ctx.deps, {
    envelopeFrom: from.address, rcptTo: to, sizeBytes: 300, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from, to: [{ address: to }], cc: [], subject, text: "Hello there", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}
const BODY = "Hi {{first_name}},\n\nThanks for writing to {{company}}. {{ My_First_Name }} here ({{my_name}}), from {{mailbox}} on {{date}}. We have {{email}} / {{name}} on file. {{order_id}} stays.";

beforeEach(async () => {
  ctx = await makeTestApp();
  ctx.deps.now = () => new Date("2026-10-26T03:00:00Z");
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
  supportId = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox.id;
  ceoId = (await owner.post("/api/mailboxes", { domainId, localPart: "ceo", displayName: "CEO" })).body.mailbox.id;
  maya = await join("maya@acme.io", "Maya Lopez", "member", [supportId]);
  max = await join("max@acme.io", "Max Member", "member", [ceoId]);
  adam = await join("adam@acme.io", "Adam Admin", "admin", []);
  await inbound("support@acme.io", "Refund for order 77", { address: "grace@example.com", name: "Grace Hopper" });
  await inbound("ceo@acme.io", "Board pack", { address: "ken@example.com", name: "Ken Thompson" });
  const threads = (await owner.get("/api/agents/threads")).body.data as { id: string; subject: string }[];
  threadId = threads.find((t) => t.subject === "Refund for order 77")!.id;
  ceoThreadId = threads.find((t) => t.subject === "Board pack")!.id;
});

describe("renderSnippet", () => {
  it("fills known variables, tolerates case and spaces, leaves unknown ones and never says undefined", () => {
    expect(renderSnippet("Hi {{first_name}}, {{ First_Name }} {{FIRST_NAME}}!", { first_name: "Grace" })).toBe("Hi Grace, Grace Grace!");
    expect(renderSnippet("Hi {{first_name}}.", {})).toBe("Hi .");
    expect(renderSnippet("Hi {{name}} {{email}}", { name: undefined, email: null })).toBe("Hi  ");
    expect(renderSnippet("Order {{order_id}} and {{ unknown }} and {{first-name}}", { first_name: "x" })).toBe("Order {{order_id}} and {{ unknown }} and {{first-name}}");
    expect(renderSnippet("{{my_name}} at {{company}} via {{mailbox}} on {{date}}", { my_name: "Olive", company: "Acme", mailbox: "support@acme.io", date: "26 October 2026" })).toBe("Olive at Acme via support@acme.io on 26 October 2026");
    expect(renderSnippet("{first_name} {{first_name}", { first_name: "x" })).toBe("{first_name} {{first_name}");
    expect(renderSnippet("$& {{name}}", { name: "$1 $& cash" })).toBe("$& $1 $& cash");
  });

  it("formats the date in a zone and parses a To field", () => {
    const d = new Date("2026-10-25T20:00:00Z");
    expect(snippetDate(d, "Australia/Sydney")).toBe("26 October 2026");
    expect(snippetDate(d, "America/New_York")).toBe("25 October 2026");
    expect(snippetDate(d, "Not/AZone")).toBe("25 October 2026");
    expect(firstRecipient("Grace Hopper <grace@example.com>, b@x.io")).toEqual({ name: "Grace Hopper", email: "grace@example.com" });
    expect(firstRecipient("\"Ken T\" <ken@example.com>")).toEqual({ name: "Ken T", email: "ken@example.com" });
    expect(firstRecipient(" b@x.io ")).toEqual({ name: "", email: "b@x.io" });
    expect(firstRecipient("")).toBeNull();
  });
});

describe("inserting in compose", () => {
  it("inserts at the cursor, replaces a selection or a typed shortcut, and fills only an empty subject", () => {
    expect(insertAt("Hello world", "big ", 6)).toEqual({ text: "Hello big world", cursor: 10 });
    expect(insertAt("Hello world", "there", 6, 11)).toEqual({ text: "Hello there", cursor: 11 });
    expect(insertAt("abc", "x", 99)).toEqual({ text: "abcx", cursor: 4 });
    expect(shortcutBeforeCursor("/thanks", 7)).toEqual({ word: "thanks", start: 0 });
    expect(shortcutBeforeCursor("Hi\n/Thanks", 10)).toEqual({ word: "thanks", start: 3 });
    expect(shortcutBeforeCursor("ok /thx more", 7)).toEqual({ word: "thx", start: 3 });
    expect(shortcutBeforeCursor("a/b", 3)).toBeNull();
    expect(shortcutBeforeCursor("see http://x", 12)).toBeNull();
    expect(shortcutBeforeCursor("/", 1)).toBeNull();
    const typed = "Hi\n/thanks";
    const sc = shortcutBeforeCursor(typed, typed.length)!;
    expect(applySnippet({ subject: "", text: typed }, { subject: "Thanks", body: "Thanks Grace" }, sc.start, typed.length)).toEqual({ subject: "Thanks", text: "Hi\nThanks Grace", cursor: 15 });
    expect(applySnippet({ subject: "Re: order", text: "" }, { subject: "Thanks", body: "Body" }, 0).subject).toBe("Re: order");
    expect(applySnippet({ subject: "", text: "x" }, { subject: "", body: "Body" }, 0)).toEqual({ subject: "", text: "Bodyx", cursor: 4 });
  });
});

describe("saved replies in the app", () => {
  it("creates, lists, edits and deletes; members create, authors and admins change", async () => {
    const made = await maya.post("/api/mail/snippets", { name: "Thanks", shortcut: "/Thanks", subject: "Re: your order", body: "Thanks {{first_name}}!" });
    expect(made.status).toBe(201);
    expect(made.body.snippet).toMatchObject({ name: "Thanks", shortcut: "thanks", shared: true, canEdit: true, createdBy: { name: "Maya Lopez" } });
    expect(made.body.snippet.id).toMatch(/^snp_/);
    const id = made.body.snippet.id;
    await owner.post("/api/mail/snippets", { name: "Apology", body: "Sorry {{first_name}}" });
    // Everyone in the workspace sees shared replies, by name.
    expect((await max.get("/api/mail/snippets")).body.snippets.map((s: { name: string }) => s.name)).toEqual(["Apology", "Thanks"]);
    expect((await max.get("/api/mail/snippets?q=than")).body.snippets.map((s: { name: string }) => s.name)).toEqual(["Thanks"]);
    expect((await max.get("/api/mail/snippets?q=/thanks")).body.snippets).toHaveLength(1);
    expect((await max.get(`/api/mail/snippets/${id}`)).body.snippet.canEdit).toBe(false);
    // Another member can't change it; the author and an admin can.
    expect((await max.patch(`/api/mail/snippets/${id}`, { name: "Mine now" })).status).toBe(403);
    expect((await max.del(`/api/mail/snippets/${id}`)).status).toBe(403);
    const edited = await maya.patch(`/api/mail/snippets/${id}`, { body: "Many thanks {{first_name}}", shortcut: null });
    expect(edited.status).toBe(200);
    expect(edited.body.snippet).toMatchObject({ body: "Many thanks {{first_name}}", shortcut: null, name: "Thanks" });
    expect((await adam.get(`/api/mail/snippets/${id}`)).body.snippet.canEdit).toBe(true);
    expect((await adam.patch(`/api/mail/snippets/${id}`, { name: "Thank you" })).body.snippet.name).toBe("Thank you");
    expect((await adam.del(`/api/mail/snippets/${id}`)).status).toBe(200);
    expect((await maya.get(`/api/mail/snippets/${id}`)).status).toBe(404);
  });

  it("keeps private replies to their author, refuses other workspaces and guests, and validates", async () => {
    const priv = (await maya.post("/api/mail/snippets", { name: "My sign off", body: "Cheers, Maya", shared: false })).body.snippet;
    expect(priv.shared).toBe(false);
    expect((await maya.get("/api/mail/snippets")).body.snippets).toHaveLength(1);
    for (const u of [owner, max, adam]) {
      expect((await u.get("/api/mail/snippets")).body.snippets).toHaveLength(0);
      expect((await u.get(`/api/mail/snippets/${priv.id}`)).status).toBe(404);
      expect((await u.post(`/api/mail/snippets/${priv.id}/render`, {})).status).toBe(404);
    }
    // Even an admin can't open someone else's private reply.
    expect((await adam.del(`/api/mail/snippets/${priv.id}`)).status).toBe(404);
    // Sharing it later makes it visible.
    await maya.patch(`/api/mail/snippets/${priv.id}`, { shared: true });
    expect((await max.get("/api/mail/snippets")).body.snippets).toHaveLength(1);

    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve", "Other");
    expect((await other.get("/api/mail/snippets")).body.snippets).toHaveLength(0);
    expect((await other.get(`/api/mail/snippets/${priv.id}`)).status).toBe(404);
    expect((await other.patch(`/api/mail/snippets/${priv.id}`, { name: "x" })).status).toBe(404);
    expect((await other.del(`/api/mail/snippets/${priv.id}`)).status).toBe(404);
    expect((await other.post(`/api/mail/snippets/${priv.id}/render`, {})).status).toBe(404);
    // No session (guests have none) is 401.
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/mail/snippets")).status).toBe(401);
    expect((await anon.post("/api/mail/snippets", { name: "x", body: "y" })).status).toBe(401);

    expect((await owner.post("/api/mail/snippets", { name: "  ", body: "y" })).status).toBe(422);
    expect((await owner.post("/api/mail/snippets", { name: "x".repeat(81), body: "y" })).status).toBe(422);
    expect((await owner.post("/api/mail/snippets", { name: "x", body: "   " })).status).toBe(422);
    expect((await owner.post("/api/mail/snippets", { name: "x", body: "y".repeat(10_001) })).status).toBe(422);
    expect((await owner.post("/api/mail/snippets", { name: "x", body: "y".repeat(10_000) })).status).toBe(201);
    expect((await owner.post("/api/mail/snippets", { name: "x", body: "y", shortcut: "two words" })).status).toBe(422);
    await owner.post("/api/mail/snippets", { name: "a", body: "y", shortcut: "dup" });
    expect((await maya.post("/api/mail/snippets", { name: "b", body: "y", shortcut: "DUP" })).status).toBe(409);
    const b = (await maya.post("/api/mail/snippets", { name: "b", body: "y", shortcut: "free" })).body.snippet;
    expect((await maya.patch(`/api/mail/snippets/${b.id}`, { shortcut: "dup" })).status).toBe(409);
    expect((await maya.patch(`/api/mail/snippets/${b.id}`, { shortcut: "free" })).status).toBe(200);
    // Other workspaces can reuse a shortcut.
    expect((await other.post("/api/mail/snippets", { name: "a", body: "y", shortcut: "dup" })).status).toBe(201);
  });

  it("renders every variable for a thread the caller can open", async () => {
    await owner.patch("/api/account/preferences", { timezone: "America/New_York" });
    const s = (await owner.post("/api/mail/snippets", { name: "Full", subject: "Re: {{name}} at {{company}}", body: BODY })).body.snippet;
    const r = await owner.post(`/api/mail/snippets/${s.id}/render`, { threadId });
    expect(r.status).toBe(200);
    expect(r.body.subject).toBe("Re: Grace Hopper at Acme");
    // 03:00 UTC on 26 October is still 25 October in New York.
    expect(r.body.body).toBe("Hi Grace,\n\nThanks for writing to Acme. Olive here (Olive Owner), from support@acme.io on 25 October 2026. We have grace@example.com / Grace Hopper on file. {{order_id}} stays.");
    // Maya has no time zone: the workspace zone (Sydney) gives 26 October. She can open the support thread.
    const m = await maya.post(`/api/mail/snippets/${s.id}/render`, { threadId });
    expect(m.body.variables).toMatchObject({ my_name: "Maya Lopez", my_first_name: "Maya", first_name: "Grace", mailbox: "support@acme.io", date: "26 October 2026" });
    // Max can't open the support thread: 404. His own mailbox's thread works.
    expect((await max.post(`/api/mail/snippets/${s.id}/render`, { threadId })).status).toBe(404);
    expect((await max.post(`/api/mail/snippets/${s.id}/render`, { threadId: ceoThreadId })).body.variables).toMatchObject({ first_name: "Ken", email: "ken@example.com", mailbox: "ceo@acme.io" });
    expect((await max.post(`/api/mail/snippets/${s.id}/render`, { mailboxId: supportId })).status).toBe(404);
    expect((await owner.post(`/api/mail/snippets/${s.id}/render`, { threadId: "nope" })).status).toBe(404);
    // A To field naming someone else wins; a To field with only an address leaves the name empty.
    const typed = await owner.post(`/api/mail/snippets/${s.id}/render`, { to: "Linus T <linus@example.com>", mailboxId: ceoId });
    expect(typed.body.variables).toMatchObject({ first_name: "Linus", name: "Linus T", email: "linus@example.com", mailbox: "ceo@acme.io" });
    const bare = await owner.post(`/api/mail/snippets/${s.id}/render`, { to: "x@example.com" });
    expect(bare.body.body).toContain("Hi ,");
    expect(bare.body.body).not.toContain("undefined");
    expect(bare.body.variables.mailbox).toBe("");
    // The same address as the thread's sender keeps the sender's name.
    expect((await owner.post(`/api/mail/snippets/${s.id}/render`, { threadId, to: "GRACE@example.com" })).body.variables.name).toBe("Grace Hopper");
    // After our reply, the newest inbound sender is still the recipient.
    const msg = (await owner.get(`/api/mail/messages?mailboxId=${supportId}`)).body.messages[0];
    await owner.post("/api/mail/send", { mailboxId: supportId, to: ["grace@example.com"], subject: "Re: Refund for order 77", text: "Done.", inReplyToId: msg.id });
    expect((await owner.post(`/api/mail/snippets/${s.id}/render`, { threadId })).body.variables.email).toBe("grace@example.com");
  });
});

describe("saved replies over the API and MCP", () => {
  it("REST: full keys write, read only keys list and render, agent keys write as the agent, other workspaces 404", async () => {
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const made = await api(key, "POST", "/snippets", { name: "Shipped", shortcut: "shipped", body: "Hi {{first_name}}, it shipped. {{my_name}}" });
    expect(made.status).toBe(201);
    const id = made.body.snippet.id;
    expect((await api(key, "GET", "/snippets")).body.snippets).toHaveLength(1);
    expect((await api(key, "GET", `/snippets/${id}`)).body.snippet.name).toBe("Shipped");
    expect((await api(key, "PATCH", `/snippets/${id}`, { subject: "Shipped" })).body.snippet.subject).toBe("Shipped");
    const r = await api(key, "POST", `/snippets/${id}/render`, { threadId });
    expect(r.status).toBe(200);
    expect(r.body.body).toBe("Hi Grace, it shipped. Olive Owner");

    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "GET", "/snippets")).body.snippets).toHaveLength(1);
    expect((await api(ro, "POST", `/snippets/${id}/render`, { threadId })).body.body).toBe("Hi Grace, it shipped. Olive Owner");
    expect((await api(ro, "POST", "/snippets", { name: "no", body: "no" })).status).toBe(403);
    expect((await api(ro, "PATCH", `/snippets/${id}`, { name: "no" })).status).toBe(403);
    expect((await api(ro, "DELETE", `/snippets/${id}`)).status).toBe(403);

    // An agent with the support mailbox renders for its thread and signs as itself; one without it gets 404.
    const helper = (await api(key, "POST", "/agents", { name: "Helper", mailboxIds: [supportId] })).body;
    const lonely = (await api(key, "POST", "/agents", { name: "Lonely", localPart: "lonely" })).body;
    expect((await api(helper.apiKey.secret, "POST", `/snippets/${id}/render`, { threadId })).body.body).toBe("Hi Grace, it shipped. Helper");
    expect((await api(lonely.apiKey.secret, "POST", `/snippets/${id}/render`, { threadId })).status).toBe(404);
    const byAgent = await api(helper.apiKey.secret, "POST", "/snippets", { name: "Agent draft", body: "From the bot", shared: false });
    expect(byAgent.status).toBe(201);
    expect(byAgent.body.snippet.createdBy).toEqual({ id: helper.agent.id, name: "Helper" });
    // Private to the agent: not in the owner's list.
    expect((await owner.get("/api/mail/snippets")).body.snippets.map((s: { name: string }) => s.name)).toEqual(["Shipped"]);
    expect((await api(helper.apiKey.secret, "PATCH", `/snippets/${id}`, { name: "x" })).status).toBe(403);
    expect((await api(key, "DELETE", `/snippets/${id}`)).status).toBe(200);

    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve", "Other");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret;
    expect((await api(otherKey, "GET", `/snippets/${byAgent.body.snippet.id}`)).status).toBe(404);
    expect((await api(otherKey, "POST", `/snippets/${byAgent.body.snippet.id}/render`, {})).status).toBe(404);
    expect((await api("mm_live_nope", "GET", "/snippets")).status).toBe(401);
  });

  it("MCP: list, render and create; read only keys can't create", async () => {
    const key = (await owner.post("/api/developer/keys", { name: "MCP" })).body.secret;
    const mcp = await mcpFor(key);
    const made = data(await mcp.callTool({ name: "create_snippet", arguments: { name: "Hello", body: "Hello {{first_name}} from {{company}}", shortcut: "hello" } }));
    expect(made.snippet.shortcut).toBe("hello");
    expect(data(await mcp.callTool({ name: "list_snippets", arguments: {} })).snippets.map((s: { name: string }) => s.name)).toEqual(["Hello"]);
    expect(data(await mcp.callTool({ name: "render_snippet", arguments: { snippetId: made.snippet.id, threadId } })).body).toBe("Hello Grace from Acme");
    expect(data(await mcp.callTool({ name: "render_snippet", arguments: { snippetId: made.snippet.id, to: "Ken <ken@example.com>" } })).body).toBe("Hello Ken from Acme");
    expect((await mcp.callTool({ name: "render_snippet", arguments: { snippetId: made.snippet.id, threadId: "nope" } })).isError).toBe(true);
    const ro = await mcpFor((await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret);
    expect(data(await ro.callTool({ name: "list_snippets", arguments: { q: "hel" } })).snippets).toHaveLength(1);
    expect(data(await ro.callTool({ name: "render_snippet", arguments: { snippetId: made.snippet.id, threadId } })).body).toBe("Hello Grace from Acme");
    expect((await ro.callTool({ name: "create_snippet", arguments: { name: "no", body: "no" } })).isError).toBe(true);
    expect((await owner.get("/api/mail/snippets")).body.snippets).toHaveLength(1);
  });
});
