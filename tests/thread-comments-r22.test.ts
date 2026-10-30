import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { parseMentions } from "@/server/services/mail/thread-comments";

/** Round 22 (R22.2): internal notes on shared inbox threads, with @mentions that notify. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let maya: Client; // member with the support mailbox
let max: Client; // member with only the ceo mailbox
let adam: Client; // admin
let supportId: string;
let ceoId: string;
let threadId: string;
let ids: Record<string, string>;
const SECRET = "Internal: refund approved up to 40 dollars, do not tell the customer about the cap";

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
  await u.signup(email, name);
  expect((await u.post(`/api/invites/${tokenOf(inv.body.link)}/accept`)).status).toBe(200);
  return u;
}
async function inbound(to: string, subject: string, text: string) {
  await deliverInbound(ctx.deps, {
    envelopeFrom: "grace@example.com", rcptTo: to, sizeBytes: text.length + 200, via: "test",
    email: { messageId: `<${Math.random().toString(36).slice(2)}@example.com>`, from: { address: "grace@example.com", name: "Grace" }, to: [{ address: to }], cc: [], subject, text, date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}
const notes = async (u: Client) => (await u.get("/api/notifications")).body.notifications as { type: string; title: string; link: string; entityId: string; category: string }[];

beforeEach(async () => {
  ctx = await makeTestApp();
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
  await inbound("support@acme.io", "Refund for order 77", "Hi, I'd like a refund for order 77 please.");
  threadId = (await owner.get("/api/agents/threads")).body.data[0].id;
  ids = {};
  for (const [k, u] of Object.entries({ owner, maya, max, adam })) ids[k] = (await u.get("/api/account/me")).body.user.id;
});

describe("thread notes in the app", () => {
  it("adds, lists oldest first, edits and deletes, and notifies the people mentioned", async () => {
    const first = await owner.post(`/api/threads/${threadId}/comments`, { body: "@Maya Lopez can you take this one? @Nobody Here @Max Member @Olive Owner" });
    expect(first.status).toBe(201);
    // Max can't open the support mailbox, Nobody Here is unknown and the author is never notified.
    expect(first.body.comment).toMatchObject({ author: { type: "member", id: ids.owner, name: "Olive Owner" }, mentions: expect.arrayContaining([{ userId: ids.maya, name: "Maya Lopez" }]), canEdit: true, canDelete: true });
    expect(first.body.comment.mentions.map((m: { userId: string }) => m.userId).sort()).toEqual([ids.maya, ids.owner].sort());
    expect(first.body.comment.id).toMatch(/^tcm_/);
    const n = await notes(maya);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ type: "thread_mention", category: "mention", entityId: threadId, title: "Olive Owner mentioned you on: Refund for order 77", link: `/app/inbox?thread=${encodeURIComponent(threadId)}` });
    expect(await notes(max)).toHaveLength(0);
    expect((await notes(owner)).filter((x) => x.type === "thread_mention")).toHaveLength(0);

    const second = await maya.post(`/api/threads/${threadId}/comments`, { body: "On it. @adam@acme.io fyi" });
    expect(second.body.comment.mentions).toEqual([{ userId: ids.adam, name: "Adam Admin" }]);
    expect((await notes(adam))[0].title).toBe("Maya Lopez mentioned you on: Refund for order 77");

    const list = (await maya.get(`/api/threads/${threadId}/comments`)).body;
    expect(list.comments.map((c: { id: string }) => c.id)).toEqual([first.body.comment.id, second.body.comment.id]);
    expect(list.comments[0]).toMatchObject({ canEdit: false, canDelete: false });
    expect(list.comments[1]).toMatchObject({ canEdit: true, canDelete: true });
    // Only people who can open the thread can be mentioned.
    expect(list.mentionable.map((m: { name: string }) => m.name).sort()).toEqual(["Adam Admin", "Maya Lopez", "Olive Owner"]);

    // Editing notifies only people newly mentioned.
    const edited = await maya.patch(`/api/threads/${threadId}/comments/${second.body.comment.id}`, { body: "On it. @Adam Admin @Olive Owner" });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.editedAt).not.toBeNull();
    expect(await notes(adam)).toHaveLength(1);
    expect((await notes(owner)).filter((x) => x.type === "thread_mention")).toHaveLength(1);

    expect((await maya.del(`/api/threads/${threadId}/comments/${second.body.comment.id}`)).status).toBe(200);
    expect((await owner.get(`/api/threads/${threadId}/comments`)).body.comments).toHaveLength(1);
    expect((await owner.get(`/api/threads/comment-counts?ids=${threadId},nope`)).body.counts).toEqual({ [threadId]: 1 });
  });

  it("checks who may read, write, edit and delete", async () => {
    const own = (await owner.post(`/api/threads/${threadId}/comments`, { body: "Owner note" })).body.comment;
    const hers = (await maya.post(`/api/threads/${threadId}/comments`, { body: "Maya note" })).body.comment;
    // Another member can't edit or delete someone else's note.
    expect((await maya.patch(`/api/threads/${threadId}/comments/${own.id}`, { body: "x" })).status).toBe(403);
    expect((await maya.del(`/api/threads/${threadId}/comments/${own.id}`)).status).toBe(403);
    // Admins and owners can delete any note but only edit their own.
    expect((await adam.patch(`/api/threads/${threadId}/comments/${hers.id}`, { body: "x" })).status).toBe(403);
    expect((await adam.del(`/api/threads/${threadId}/comments/${hers.id}`)).status).toBe(200);
    // A member without the mailbox gets 404 for everything.
    expect((await max.get(`/api/threads/${threadId}/comments`)).status).toBe(404);
    expect((await max.post(`/api/threads/${threadId}/comments`, { body: "sneaky" })).status).toBe(404);
    expect((await max.del(`/api/threads/${threadId}/comments/${own.id}`)).status).toBe(404);
    expect((await max.get(`/api/threads/comment-counts?ids=${threadId}`)).body.counts).toEqual({});
    // No session (guests have none) is 401; another workspace is 404.
    const anon = new Client(ctx.app);
    expect((await anon.get(`/api/threads/${threadId}/comments`)).status).toBe(401);
    expect((await anon.post(`/api/threads/${threadId}/comments`, { body: "x" })).status).toBe(401);
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve", "Other");
    expect((await other.get(`/api/threads/${threadId}/comments`)).status).toBe(404);
    expect((await other.post(`/api/threads/${threadId}/comments`, { body: "x" })).status).toBe(404);
    expect((await other.del(`/api/threads/${threadId}/comments/${own.id}`)).status).toBe(404);
    // A note id from this thread used on another thread is not found.
    await inbound("support@acme.io", "Another one", "Second thread");
    const second = (await owner.get("/api/agents/threads")).body.data.find((t: { subject: string }) => t.subject === "Another one").id;
    expect((await owner.del(`/api/threads/${second}/comments/${own.id}`)).status).toBe(404);
    // Validation: empty and too long.
    expect((await owner.post(`/api/threads/${threadId}/comments`, { body: "   " })).status).toBe(422);
    expect((await owner.post(`/api/threads/${threadId}/comments`, { body: "x".repeat(4001) })).status).toBe(422);
    expect((await owner.post(`/api/threads/${threadId}/comments`, { body: "x".repeat(4000) })).status).toBe(201);
    // Edits close after 24 hours.
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 25 * 3600_000);
    expect((await owner.patch(`/api/threads/${threadId}/comments/${own.id}`, { body: "late" })).status).toBe(409);
    ctx.deps.now = real;
  });

  it("parses mentions: names with spaces, emails, longest name first, unknown names ignored", () => {
    const people = [
      { userId: "u1", name: "Max", email: "max@acme.io" },
      { userId: "u2", name: "Max Member", email: "mm@acme.io" },
      { userId: "u3", name: "Maya Lopez", email: "maya@acme.io" },
    ];
    expect(parseMentions("@Max Member please look", people)).toEqual(["u2"]);
    expect(parseMentions("@max and @MAYA LOPEZ.", people).sort()).toEqual(["u1", "u3"]);
    expect(parseMentions("ping @mm@acme.io", people)).toEqual(["u2"]);
    expect(parseMentions("no mention of Max, email max@acme.io, @Maxwell, @Nobody", people)).toEqual([]);
    expect(parseMentions("hi", people, ["u3", "MAX@acme.io", "stranger@x.io", "u9"]).sort()).toEqual(["u1", "u3"]);
  });
});

describe("notes never leave the team", () => {
  it("keeps note text out of replies, sends, quotes and thread reads", async () => {
    await owner.post(`/api/threads/${threadId}/comments`, { body: `${SECRET} @Maya Lopez` });
    const wsKey = (await owner.post("/api/developer/keys", { name: "Agents" })).body.secret;
    const { agent, apiKey } = (await api(wsKey, "POST", "/agents", { name: "Helper", mailboxIds: [supportId], approvalMode: "never" })).body;
    // An agent reply in the thread (replyInThread, the reply quote and send.ts).
    const reply = await api(apiKey.secret, "POST", `/agents/${agent.id}/threads/${threadId}/reply`, { text: "Sorry about that. It ships today." });
    expect(reply.body.status).toBe("sent");
    // A person's reply from the mailbox.
    const msg = (await owner.get(`/api/mail/messages?mailboxId=${supportId}`)).body.messages[0];
    const sent = await owner.post("/api/mail/send", { mailboxId: supportId, to: ["grace@example.com"], subject: "Re: Refund for order 77", text: "Done, refunded.", inReplyToId: msg.id });
    expect(sent.status).toBe(201);
    expect(ctx.outbound.sent.length).toBeGreaterThanOrEqual(2);
    for (const m of ctx.outbound.sent) expect(JSON.stringify(m)).not.toContain("refund approved up to 40");
    // Thread reads (app, public API, MCP) carry no notes unless notes are asked for.
    expect(JSON.stringify((await owner.get(`/api/agents/threads/${threadId}`)).body)).not.toContain("refund approved up to 40");
    expect(JSON.stringify((await api(apiKey.secret, "GET", `/threads/${threadId}`)).body)).not.toContain("refund approved up to 40");
    const mcp = await mcpFor(apiKey.secret);
    expect(JSON.stringify(await mcp.callTool({ name: "read_thread", arguments: { threadId } }))).not.toContain("refund approved up to 40");
    expect(JSON.stringify((await owner.get(`/api/mail/messages?mailboxId=${supportId}`)).body)).not.toContain("refund approved up to 40");
    // Asking for notes explicitly does return them.
    expect(JSON.stringify((await api(apiKey.secret, "GET", `/threads/${threadId}/comments`)).body)).toContain("refund approved up to 40");
  });
});

describe("thread notes over the API and MCP", () => {
  it("lists, adds, edits and deletes over REST; read only keys only read; agent keys write as the agent", async () => {
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const made = await api(key, "POST", `/threads/${threadId}/comments`, { body: "From the API", mentions: ["maya@acme.io", ids.max] });
    expect(made.status).toBe(201);
    expect(made.body.comment.mentions).toEqual([{ userId: ids.maya, name: "Maya Lopez" }]);
    expect((await notes(maya))).toHaveLength(1);
    expect((await notes(max))).toHaveLength(0);
    expect((await api(key, "GET", `/threads/${threadId}/comments`)).body.comments).toHaveLength(1);
    expect((await api(key, "PATCH", `/threads/${threadId}/comments/${made.body.comment.id}`, { body: "Edited" })).body.comment.body).toBe("Edited");
    const ro = (await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret;
    expect((await api(ro, "GET", `/threads/${threadId}/comments`)).body.comments).toHaveLength(1);
    expect((await api(ro, "POST", `/threads/${threadId}/comments`, { body: "no" })).status).toBe(403);
    expect((await api(ro, "DELETE", `/threads/${threadId}/comments/${made.body.comment.id}`)).status).toBe(403);
    // An agent with the support mailbox writes as itself; one without it gets 404.
    const helper = (await api(key, "POST", "/agents", { name: "Helper", mailboxIds: [supportId] })).body;
    const lonely = (await api(key, "POST", "/agents", { name: "Lonely", localPart: "lonely" })).body;
    const byAgent = await api(helper.apiKey.secret, "POST", `/threads/${threadId}/comments`, { body: "Customer has 2 earlier refunds. @Maya Lopez" });
    expect(byAgent.status).toBe(201);
    expect(byAgent.body.comment.author).toEqual({ type: "agent", id: helper.agent.id, name: "Helper" });
    expect((await notes(maya))[0].title).toBe("Helper mentioned you on: Refund for order 77");
    expect((await api(lonely.apiKey.secret, "GET", `/threads/${threadId}/comments`)).status).toBe(404);
    expect((await api(lonely.apiKey.secret, "POST", `/threads/${threadId}/comments`, { body: "x" })).status).toBe(404);
    // An agent can't edit someone else's note; a workspace key deletes any.
    expect((await api(helper.apiKey.secret, "PATCH", `/threads/${threadId}/comments/${made.body.comment.id}`, { body: "x" })).status).toBe(403);
    expect((await api(key, "DELETE", `/threads/${threadId}/comments/${byAgent.body.comment.id}`)).status).toBe(200);
    // Another workspace's key can't see this thread.
    const other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve", "Other");
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret;
    expect((await api(otherKey, "GET", `/threads/${threadId}/comments`)).status).toBe(404);
    expect((await api(otherKey, "POST", `/threads/${threadId}/comments`, { body: "x" })).status).toBe(404);
  });

  it("works over MCP, and read only keys can list but not write", async () => {
    const key = (await owner.post("/api/developer/keys", { name: "MCP" })).body.secret;
    const mcp = await mcpFor(key);
    const added = data(await mcp.callTool({ name: "add_thread_comment", arguments: { threadId, body: "Checked the order, it shipped.", mentions: ["maya@acme.io"] } }));
    expect(added.comment.mentions).toEqual([{ userId: ids.maya, name: "Maya Lopez" }]);
    const listed = data(await mcp.callTool({ name: "list_thread_comments", arguments: { threadId } }));
    expect(listed.comments.map((c: { body: string }) => c.body)).toEqual(["Checked the order, it shipped."]);
    const ro = await mcpFor((await owner.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret);
    expect(data(await ro.callTool({ name: "list_thread_comments", arguments: { threadId } })).comments).toHaveLength(1);
    expect((await ro.callTool({ name: "add_thread_comment", arguments: { threadId, body: "no" } })).isError).toBe(true);
    expect((await ro.callTool({ name: "delete_thread_comment", arguments: { threadId, commentId: added.comment.id } })).isError).toBe(true);
    expect(data(await mcp.callTool({ name: "delete_thread_comment", arguments: { threadId, commentId: added.comment.id } })).ok).toBe(true);
    expect((await mcp.callTool({ name: "list_thread_comments", arguments: { threadId: "nope" } })).isError).toBe(true);
  });
});
