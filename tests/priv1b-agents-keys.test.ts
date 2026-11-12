/**
 * PRIV1b batch "agents-keys": P3, P4, P31, P51, P47, P27, P8. Agents reach a personal mailbox only when their maker
 * owns it; agent events, the event stream, read status and data moves stay inside the caller's own scope.
 */
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { privacyWorld, verifiedDomain } from "./priv1a-world";
import { agentEvents, agentMailboxAccess, apiKeys, messages } from "@/server/db/schema";
import { notifyAgentsOfInbound, eventsSince } from "@/server/services/agents";
import { startExport } from "@/server/services/data-move/service";

type W = Awaited<ReturnType<typeof privacyWorld>>;

async function v1(w: W, key: string, method: string, path: string, body?: unknown) {
  const res = await w.ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const wsKey = async (c: W["admin"]["c"]) => (await c.post("/api/developer/keys", { name: "ws" })).body.secret as string;

/** Pat becomes an admin (members can't make agents) and makes an agent on her own personal mailbox. */
async function patAgent(w: W, approvalMode: "always" | "never" = "always") {
  expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
  const r = await w.pat.c.post("/api/agents", { name: "Pat helper", localPart: `pathelper${w.n}`, approvalMode, mailboxIds: [w.boxes.personal], allowedRecipients: null }); // AIS1: a person picks "anyone"
  expect(r.status).toBe(201);
  expect(r.body.agent.mailboxIds).toContain(w.boxes.personal);
  return { id: r.body.agent.id as string, inbox: r.body.agent.inboxId as string, secret: r.body.apiKey.secret as string, keyId: r.body.apiKey.id as string };
}

describe("PRIV1b P3/P4: personal mailboxes go on an agent only by their owner", () => {
  it("refuses an admin, a workspace key and a delegate; the owner and team mailboxes still work", async () => {
    const w = await privacyWorld();
    const adaKey = await wsKey(w.admin.c);
    const no = await w.admin.c.post("/api/agents", { name: "Ada bot", localPart: `adabot${w.n}`, mailboxIds: [w.boxes.personal] });
    expect(no.status).toBe(403);
    expect(JSON.stringify(no.body)).not.toContain(`SUBJECT-PERS`);
    expect((await v1(w, adaKey, "POST", "/agents", { name: "Ada bot2", localPart: `adabot2${w.n}`, mailboxIds: [w.boxes.personal] })).status).toBe(403);
    // A share at any level counts for nothing (Sam holds send_as, but members can't make agents anyway; Ada gets send_as).
    await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "send_as" });
    expect((await w.admin.c.post("/api/agents", { name: "Ada bot3", localPart: `adabot3${w.n}`, mailboxIds: [w.boxes.personal] })).status).toBe(403);
    // Team mailbox: unchanged.
    const ok = await w.admin.c.post("/api/agents", { name: "Ada team bot", localPart: `adateam${w.n}`, mailboxIds: [w.boxes.team] });
    expect(ok.status).toBe(201);
    expect(ok.body.agent.mailboxIds).toContain(w.boxes.team);
    // Update: adding a personal mailbox is refused before anything is written.
    const up = await w.admin.c.patch(`/api/agents/${ok.body.agent.id}`, { mailboxIds: [w.boxes.team, w.boxes.personal] });
    expect(up.status).toBe(403);
    const held = await w.ctx.db.select({ m: agentMailboxAccess.mailboxId }).from(agentMailboxAccess).where(eq(agentMailboxAccess.agentId, ok.body.agent.id));
    expect(held.map((r) => r.m)).toEqual([w.boxes.team]);
    expect((await w.admin.c.patch(`/api/agents/${ok.body.agent.id}`, { mailboxIds: [w.boxes.team], name: "Renamed" })).status).toBe(200);

    // The owner attaches her own.
    const pa = await patAgent(w);
    // Another admin editing Pat's agent keeps what it holds, but can't mint a key for it (app or workspace key).
    expect((await w.admin.c.patch(`/api/agents/${pa.id}`, { mailboxIds: [w.boxes.personal], name: "Pat helper 2" })).status).toBe(200);
    expect((await w.admin.c.post(`/api/agents/${pa.id}/keys`, { name: "x" })).status).toBe(403);
    expect((await v1(w, adaKey, "POST", `/agents/${pa.id}/keys`, { name: "x" })).status).toBe(403);
    expect((await w.pat.c.post(`/api/agents/${pa.id}/keys`, { name: "mine" })).status).toBe(201);
    // Keys for an agent with no personal mailbox: any admin, as before.
    expect((await w.owner.post(`/api/agents/${ok.body.agent.id}/keys`, { name: "y" })).status).toBe(201);
  }, 120_000);

  it("a maker's share no longer opens the mailbox to the agent's key: no read, no bulk trash", async () => {
    const w = await privacyWorld();
    await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "send_as" });
    const ag = await w.admin.c.post("/api/agents", { name: "Ada helper", localPart: `adahelper${w.n}`, mailboxIds: [w.boxes.team] });
    expect(ag.status).toBe(201);
    // An attachment made before this fix (or by the share path) is still in the table.
    await w.ctx.db.insert(agentMailboxAccess).values({ agentId: ag.body.agent.id, mailboxId: w.boxes.personal, orgId: w.orgId });
    const key = ag.body.apiKey.secret as string;
    const got = await v1(w, key, "GET", `/agents/${ag.body.agent.id}`);
    expect(got.body.mailboxIds).not.toContain(w.boxes.personal);
    expect((await v1(w, key, "GET", `/threads/thr_pers${w.n}aaaaaaaaaa`)).status).toBe(404);
    const bulk = await v1(w, key, "POST", "/mail/messages/bulk", { ids: [w.msgs.personal, w.msgs.team], action: "trash" });
    expect(bulk.status).toBe(200);
    expect(JSON.stringify(bulk.body)).not.toContain("SUBJECT-PERS");
    const folder = async (id: string) => (await w.ctx.db.select({ f: messages.folder }).from(messages).where(eq(messages.id, id)).get())!.f;
    expect(await folder(w.msgs.personal)).toBe("inbox");
    expect(await folder(w.msgs.team)).toBe("trash");
    // The owner's own agent still reads her mailbox.
    const pa = await patAgent(w);
    expect((await v1(w, pa.secret, "GET", `/threads/thr_pers${w.n}aaaaaaaaaa`)).status).toBe(200);
    // Another admin's workspace key listing Pat's agent's threads doesn't get Pat's mail; Pat's own key does.
    const adaKey = await wsKey(w.admin.c);
    expect(JSON.stringify((await v1(w, adaKey, "GET", `/agents/${pa.id}/threads?limit=50`)).body)).not.toContain(`SUBJECT-PERS-${w.n}`);
    expect(JSON.stringify((await v1(w, pa.secret, "GET", `/agents/${pa.id}/threads?limit=50`)).body)).toContain(`SUBJECT-PERS-${w.n}`);
  }, 120_000);

  it("inbound events reach only agents the owner made, and event reads keep to the caller's scope", async () => {
    const w = await privacyWorld();
    const pa = await patAgent(w);
    const ada = await w.admin.c.post("/api/agents", { name: "Ada helper", localPart: `adahelper${w.n}`, mailboxIds: [w.boxes.team] });
    const adaAgent = ada.body.agent.id as string;
    await w.ctx.db.insert(agentMailboxAccess).values({ agentId: adaAgent, mailboxId: w.boxes.personal, orgId: w.orgId });
    const inbound = (mailboxId: string, tag: string) => notifyAgentsOfInbound(w.ctx.deps, { id: mailboxId, orgId: w.orgId }, { id: `msg_${tag}`, threadId: `thr_${tag}`, from: { address: "x@example.com" }, subject: `CODE-${tag}`, text: "Your code is 482913" });
    const p = await inbound(w.boxes.personal, "PERSONALIN");
    expect(p.agentIds).toEqual([pa.id]);
    const t = await inbound(w.boxes.team, "TEAMIN");
    expect(t.agentIds).toEqual([adaAgent]);
    // Pat's agent can still hold an event from before (written by the old rule) for Ada's agent: reads filter too.
    await w.ctx.db.insert(agentEvents).values({ orgId: w.orgId, agentId: adaAgent, type: "message.received", data: JSON.stringify({ mailboxId: w.boxes.personal, subject: "CODE-OLDLEAK" }) });

    const adaKey = await wsKey(w.admin.c);
    const all = JSON.stringify((await v1(w, adaKey, "GET", "/events?limit=500")).body);
    expect(all).toContain("CODE-TEAMIN");
    expect(all).not.toContain("CODE-PERSONALIN");
    expect(all).not.toContain("CODE-OLDLEAK");
    expect(JSON.stringify((await v1(w, adaKey, "GET", `/events?agentId=${pa.id}`)).body)).not.toContain("CODE-PERSONALIN");
    // Ada's agent key: the old event for Pat's mailbox is gone, its team event stays.
    const adaAgentEvents = JSON.stringify((await v1(w, ada.body.apiKey.secret, "GET", "/events")).body);
    expect(adaAgentEvents).toContain("CODE-TEAMIN");
    expect(adaAgentEvents).not.toContain("CODE-OLDLEAK");
    // The owner's agent key and the owner herself see her own mail's event.
    expect(JSON.stringify((await v1(w, pa.secret, "GET", "/events")).body)).toContain("CODE-PERSONALIN");
    const patKey = await wsKey(w.pat.c);
    expect(JSON.stringify((await v1(w, patKey, "GET", "/events?limit=500")).body)).toContain("CODE-PERSONALIN");
    // Service level, a person with no share: none of Pat's.
    const owner = { userId: (await w.owner.get("/api/account/me")).body.user.id, orgId: w.orgId, role: "owner" as const, email: "o", name: "o", sessionId: "s" };
    expect(JSON.stringify(await eventsSince(w.ctx.deps, owner, { limit: 500 }))).not.toContain("CODE-PERSONALIN");
  }, 120_000);
});

describe("PRIV1b P31: an agent sends from its maker's own personal mailbox", () => {
  it("approvalMode never sends as the maker; another admin's workspace key can't send from it", async () => {
    const w = await privacyWorld();
    const pa = await patAgent(w, "never");
    const sent = await v1(w, pa.secret, "POST", `/agents/${pa.id}/send`, { mailboxId: w.boxes.personal, to: [`max${w.n}@acme.io`], subject: "From Pat's box", text: "hello" });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("sent");
    expect((await v1(w, pa.secret, "POST", `/agents/${pa.id}/send`, { to: [`max${w.n}@acme.io`], subject: "From the agent inbox", text: "hi" })).status).toBe(200);
    const adaKey = await wsKey(w.admin.c);
    const other = await v1(w, adaKey, "POST", `/agents/${pa.id}/send`, { mailboxId: w.boxes.personal, to: [`max${w.n}@acme.io`], subject: "Not Ada's", text: "x" });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("mailbox_not_allowed");
  }, 120_000);
});

describe("PRIV1b P51: external approval mode treats other workspaces as outside", () => {
  it("another workspace's mailbox waits for approval; this workspace's mailbox does not", async () => {
    const w = await privacyWorld();
    const otherDomain = await verifiedDomain(w.ctx, w.outsider, `other${w.n}.io`);
    const mb = await w.outsider.post("/api/mailboxes", { domainId: otherDomain, localPart: "hello", displayName: "Hello" });
    expect(mb.status).toBe(201);
    const ag = await w.admin.c.post("/api/agents", { name: "Outreach", localPart: `outreach${w.n}`, approvalMode: "external", mailboxIds: [w.boxes.team], allowedRecipients: null }); // AIS1: "anyone", or the other workspace is off the list
    const key = ag.body.apiKey.secret as string;
    const inside = await v1(w, key, "POST", `/agents/${ag.body.agent.id}/send`, { to: ["team@acme.io"], subject: "Inside", text: "x" });
    expect(inside.status).toBe(200);
    expect(inside.body.status).toBe("sent");
    const cross = await v1(w, key, "POST", `/agents/${ag.body.agent.id}/send`, { to: [`hello@other${w.n}.io`], subject: "Other workspace", text: "x" });
    expect(cross.status).toBe(202);
    expect(cross.body.status).toBe("pending_approval");
  }, 120_000);
});

describe("PRIV1b P47: the agent event stream ends once its key is revoked", () => {
  async function open(w: W, agentId: string, secret: string) {
    const res = await w.ctx.app.request(`/api/v1/agents/${agentId}/events/stream?timeout=900`, { headers: { authorization: `Bearer ${secret}`, host: "localhost" } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = async (pred: (t: string) => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!pred(text)) {
        const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined; timeout: true }>((ok) => setTimeout(() => ok({ done: true, value: undefined, timeout: true }), Math.max(1, end - Date.now())))]);
        if ("timeout" in r) return { text, closed: false };
        if (r.done) return { text, closed: true };
        text += dec.decode(r.value);
      }
      return { text, closed: false };
    };
    return { until, cancel: () => reader.cancel().catch(() => undefined) };
  }
  const event = (w: W, agentId: string, mailboxId: string, subject: string) =>
    w.ctx.db.insert(agentEvents).values({ orgId: w.orgId, agentId, type: "message.received", data: JSON.stringify({ mailboxId, subject }) });

  it("a revoked key gets nothing more and the stream closes; a live key keeps getting events", async () => {
    const w = await privacyWorld();
    const ag = await w.admin.c.post("/api/agents", { name: "Streamer", localPart: `streamer${w.n}` });
    const { id, inboxId } = ag.body.agent;
    const realNow = Date.now.bind(Date);
    try {
      // Live key: the event arrives even after the 30 second re-check.
      const live = await open(w, id, ag.body.apiKey.secret);
      expect((await live.until((t) => t.includes("event: ready"))).text).toContain("event: ready");
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
      await event(w, id, inboxId, "LIVE-482913");
      expect((await live.until((t) => t.includes("LIVE-482913"))).text).toContain("LIVE-482913");
      await live.cancel();
      vi.restoreAllMocks();

      // Revoked key: the stream ends at the next re-check and never sends the new code.
      const k2 = await w.admin.c.post(`/api/agents/${id}/keys`, { name: "second" });
      const s = await open(w, id, k2.body.secret ?? k2.body.apiKey?.secret);
      expect((await s.until((t) => t.includes("event: ready"))).text).toContain("event: ready");
      await new Promise((r) => setTimeout(r, 500)); // the first poll has run and the loop sleeps
      const keyId = k2.body.apiKey?.id ?? k2.body.id;
      await w.ctx.db.delete(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, w.orgId)));
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
      await event(w, id, inboxId, "REVOKED-771204");
      const after = await s.until(() => false, 8_000);
      expect(after.closed).toBe(true);
      expect(after.text).not.toContain("REVOKED-771204");
    } finally { vi.restoreAllMocks(); }
  }, 120_000);
});

describe("PRIV1b P27: v1 read status with an agent key uses the agent's scope", () => {
  it("an agent key can't read status of team or creator-shared personal mail; a workspace key still can", async () => {
    const w = await privacyWorld();
    await w.pat.c.put(`/api/mailboxes/${w.boxes.personal}/sharing/${w.admin.id}`, { level: "read" });
    const ag = await w.admin.c.post("/api/agents", { name: "Helper", localPart: `helper${w.n}` });
    const key = ag.body.apiKey.secret as string;
    for (const id of [w.msgs.team, w.msgs.personal]) {
      const r = await v1(w, key, "GET", `/mail/messages/${id}/read-status`);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("SUBJECT-");
    }
    const adaKey = await wsKey(w.admin.c);
    const ok = await v1(w, adaKey, "GET", `/mail/messages/${w.msgs.team}/read-status`);
    expect(ok.status).toBe(200);
    expect(ok.body.readStatus.subject).toBe(`SUBJECT-TEAM-${w.n}`);
  }, 120_000);
});

describe("PRIV1b P8: agent keys can't export or import the workspace", () => {
  it("refuses the agent key on v1, MCP and the service; a workspace key still exports", async () => {
    const w = await privacyWorld();
    const ag = await w.admin.c.post("/api/agents", { name: "Helper", localPart: `helper${w.n}` });
    const key = ag.body.apiKey.secret as string;
    const ex = await v1(w, key, "POST", "/data-moves/exports");
    expect(ex.status).toBe(403);
    expect(ex.body.error.code).toBe("agent_key_scope");
    expect(JSON.stringify(ex.body)).not.toContain("downloadUrl");
    expect((await v1(w, key, "GET", "/data-moves")).status).toBe(403);
    expect((await v1(w, key, "POST", "/data-moves/imports/run", { kind: "contacts", content: "BEGIN:VCARD\nFN:A\nEND:VCARD" })).status).toBe(403);
    await expect(startExport(w.ctx.deps, { orgId: w.orgId, userId: w.admin.id, email: "a", name: "a", role: "admin", agentId: ag.body.agent.id })).rejects.toMatchObject({ status: 403 });

    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => w.ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "t", version: "1" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const r = await mcp.callTool({ name: "export_workspace", arguments: {} }) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).not.toContain("downloadUrl");
    const l = await mcp.callTool({ name: "list_data_moves", arguments: {} }) as { isError?: boolean };
    expect(l.isError).toBe(true);
    await mcp.close();

    const adaKey = await wsKey(w.admin.c);
    const good = await v1(w, adaKey, "POST", "/data-moves/exports");
    expect(good.status).toBe(200);
    expect(good.body.downloadUrl ?? good.body.export?.downloadUrl ?? JSON.stringify(good.body)).toContain("download");
  }, 120_000);
});

// ---- Review fixes (M1, M2, S1..S4) ----

async function mcpFor(w: W, key: string) {
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => w.ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const mcp = new McpClient({ name: "t", version: "1" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, text: JSON.stringify(r.content) };
  };
  return { call, close: () => mcp.close() };
}

describe("PRIV1b M1: MCP agent tools keep to the caller's scope, like v1", () => {
  it("another admin's workspace key can't list, read codes from or reply from the maker's personal mailbox through her agent", async () => {
    const w = await privacyWorld();
    const pa = await patAgent(w, "never");
    await notifyAgentsOfInbound(w.ctx.deps, { id: w.boxes.personal, orgId: w.orgId }, { id: "msg_mcpcode", threadId: "thr_mcpcode", from: { address: "x@example.com" }, subject: "CODE-MCPPERS", text: "Your code is 551177" });
    const adaKey = await wsKey(w.admin.c);
    const ada = await mcpFor(w, adaKey);
    try {
      const list = await ada.call("list_threads", { agentId: pa.id, limit: 50 });
      expect(list.isError).toBe(false);
      expect(list.text).not.toContain(`SUBJECT-PERS-${w.n}`);
      const wait = await ada.call("wait_for_email", { agentId: pa.id, cursor: 0, timeoutSeconds: 0 });
      expect(wait.isError).toBe(false);
      expect(wait.text).not.toContain("CODE-MCPPERS");
      expect(wait.text).not.toContain("551177");
      const rep = await ada.call("reply", { agentId: pa.id, threadId: `thr_pers${w.n}aaaaaaaaaa`, text: "Ada as Pat" });
      expect(rep.isError).toBe(true);
      const mine = await w.ctx.db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.folder, "sent")));
      expect(mine).toEqual([]);
    } finally { await ada.close(); }

    // Pat's own agent key: lists, reads the code and replies from her mailbox (approval "never"), as Pat's box.
    const pat = await mcpFor(w, pa.secret);
    try {
      expect((await pat.call("list_threads", { limit: 50 })).text).toContain(`SUBJECT-PERS-${w.n}`);
      expect((await pat.call("wait_for_email", { cursor: 0, timeoutSeconds: 0 })).text).toContain("551177");
      const rep = await pat.call("reply", { threadId: `thr_pers${w.n}aaaaaaaaaa`, text: "Pat's agent" });
      expect(rep.isError).toBe(false);
      expect(rep.text).toContain("sent");
      const sent = await w.ctx.db.select({ from: messages.fromAddress }).from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.folder, "sent"))).all();
      expect(sent.map((r) => r.from)).toEqual([`pat.private${w.n}@acme.io`]);
    } finally { await pat.close(); }

    // A team agent through Ada's workspace key: unchanged.
    const team = await w.admin.c.post("/api/agents", { name: "Team bot", localPart: `teambot${w.n}`, mailboxIds: [w.boxes.team] });
    const ada2 = await mcpFor(w, adaKey);
    try { expect((await ada2.call("list_threads", { agentId: team.body.agent.id, limit: 50 })).text).toContain(`SUBJECT-TEAM-${w.n}`); } finally { await ada2.close(); }
  }, 120_000);
});

describe("PRIV1b M2: a poller never stalls behind events it can't see", () => {
  it("600 hidden events then a visible one: /events and wait_for_email return the visible one", async () => {
    const w = await privacyWorld();
    const ag = await w.admin.c.post("/api/agents", { name: "Ada helper", localPart: `adahelper${w.n}`, mailboxIds: [w.boxes.team] });
    const id = ag.body.agent.id as string;
    const rows = Array.from({ length: 600 }, (_, i) => ({ orgId: w.orgId, agentId: id, type: "message.received", data: JSON.stringify({ mailboxId: w.boxes.personal, subject: `HIDDEN-${i}` }) }));
    for (let i = 0; i < rows.length; i += 15) await w.ctx.db.insert(agentEvents).values(rows.slice(i, i + 15));
    await w.ctx.db.insert(agentEvents).values({ orgId: w.orgId, agentId: id, type: "message.received", data: JSON.stringify({ mailboxId: w.boxes.team, subject: "VISIBLE-TEAM" }) });
    const adaKey = await wsKey(w.admin.c);
    const r = await v1(w, adaKey, "GET", "/events?after=0&limit=100");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain("VISIBLE-TEAM");
    expect(JSON.stringify(r.body)).not.toContain("HIDDEN-");
    const m = await mcpFor(w, adaKey);
    try {
      const wait = await m.call("wait_for_email", { agentId: id, cursor: 0, timeoutSeconds: 0 });
      expect(wait.text).toContain("VISIBLE-TEAM");
      expect(wait.text).not.toContain("HIDDEN-");
    } finally { await m.close(); }
  }, 120_000);
});

describe("PRIV1b S2/S3: aliases that forward outside, and approval events", () => {
  it("an own alias forwarding outside waits; an alias to a team mailbox does not", async () => {
    const w = await privacyWorld();
    expect((await w.owner.post("/api/aliases", { domainId: w.domainId, localPart: `fwd${w.n}`, destinations: ["someone@gmail.com"] })).status).toBe(201);
    expect((await w.owner.post("/api/aliases", { domainId: w.domainId, localPart: `inner${w.n}`, destinations: ["team@acme.io"] })).status).toBe(201);
    const ag = await w.admin.c.post("/api/agents", { name: "Outreach", localPart: `outreach${w.n}`, approvalMode: "external", mailboxIds: [w.boxes.team] });
    const key = ag.body.apiKey.secret as string;
    const out = await v1(w, key, "POST", `/agents/${ag.body.agent.id}/send`, { to: [`fwd${w.n}@acme.io`], subject: "Via alias", text: "x" });
    expect(out.status).toBe(202);
    expect(out.body.status).toBe("pending_approval");
    const inn = await v1(w, key, "POST", `/agents/${ag.body.agent.id}/send`, { to: [`inner${w.n}@acme.io`], subject: "Inner alias", text: "x" });
    expect(inn.status).toBe(200);
    expect(inn.body.status).toBe("sent");
  }, 120_000);

  it("approval.requested for a personal-mailbox send reaches only the scope that can open it", async () => {
    const w = await privacyWorld();
    const pa = await patAgent(w, "always");
    const q = await v1(w, pa.secret, "POST", `/agents/${pa.id}/send`, { mailboxId: w.boxes.personal, to: [`max${w.n}@acme.io`], subject: "APPROVE-PERSONAL", text: "x" });
    expect(q.status).toBe(202);
    const team = await w.admin.c.post("/api/agents", { name: "Team bot", localPart: `teambot${w.n}`, mailboxIds: [w.boxes.team] });
    expect((await v1(w, team.body.apiKey.secret, "POST", `/agents/${team.body.agent.id}/send`, { mailboxId: w.boxes.team, to: [`max${w.n}@acme.io`], subject: "APPROVE-TEAM", text: "x" })).status).toBe(202);
    const adaKey = await wsKey(w.admin.c);
    const seen = JSON.stringify((await v1(w, adaKey, "GET", "/events?limit=500")).body);
    expect(seen).toContain("APPROVE-TEAM");
    expect(seen).not.toContain("APPROVE-PERSONAL");
    expect(JSON.stringify((await v1(w, pa.secret, "GET", "/events")).body)).toContain("APPROVE-PERSONAL");
  }, 120_000);
});

describe("PRIV1b S4: test gaps", () => {
  it("P31: the send is stored in the maker's personal mailbox, from her address", async () => {
    const w = await privacyWorld();
    const pa = await patAgent(w, "never");
    const sent = await v1(w, pa.secret, "POST", `/agents/${pa.id}/send`, { mailboxId: w.boxes.personal, to: [`max${w.n}@acme.io`], subject: "STORED-PAT", text: "hello" });
    expect(sent.status).toBe(200);
    const row = await w.ctx.db.select().from(messages).where(eq(messages.subject, "STORED-PAT")).all();
    const mine = row.filter((r) => r.mailboxId === w.boxes.personal);
    expect(mine.length).toBe(1);
    expect(mine[0].folder).toBe("sent");
    expect(mine[0].fromAddress).toBe(`pat.private${w.n}@acme.io`);
  }, 120_000);

  it("P47: the stream ends once the key's creator leaves the workspace", async () => {
    const w = await privacyWorld();
    const ag = await w.owner.post("/api/agents", { name: "Streamer", localPart: `streamer${w.n}` });
    const { id, inboxId } = ag.body.agent;
    const adaKey = await wsKey(w.admin.c);
    const res = await w.ctx.app.request(`/api/v1/agents/${id}/events/stream?timeout=900`, { headers: { authorization: `Bearer ${adaKey}`, host: "localhost" } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const readFor = async (ms: number) => {
      const end = Date.now() + ms;
      for (;;) {
        const r = await Promise.race([reader.read(), new Promise<{ timeout: true }>((ok) => setTimeout(() => ok({ timeout: true }), Math.max(1, end - Date.now())))]);
        if ("timeout" in r) return false;
        if (r.done) return true;
        text += dec.decode(r.value);
      }
    };
    const realNow = Date.now.bind(Date);
    try {
      await readFor(1_000);
      expect(text).toContain("event: ready");
      expect((await w.owner.del(`/api/team/members/${w.admin.id}`)).status).toBeLessThan(300);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
      await w.ctx.db.insert(agentEvents).values({ orgId: w.orgId, agentId: id, type: "message.received", data: JSON.stringify({ mailboxId: inboxId, subject: "GONE-ADA" }) });
      const closed = await readFor(8_000);
      expect(closed).toBe(true);
      expect(text).not.toContain("GONE-ADA");
    } finally { vi.restoreAllMocks(); await reader.cancel().catch(() => undefined); }
  }, 120_000);

  it("P8: MCP import_file and undo_import refuse an agent key", async () => {
    const w = await privacyWorld();
    const ag = await w.admin.c.post("/api/agents", { name: "Helper", localPart: `helper${w.n}` });
    const m = await mcpFor(w, ag.body.apiKey.secret);
    try {
      const imp = await m.call("import_file", { kind: "contacts", content: "BEGIN:VCARD\nFN:A\nEND:VCARD" });
      expect(imp.isError).toBe(true);
      expect(imp.text).toContain("agent");
      expect((await m.call("undo_import", { id: "mov_whatever" })).isError).toBe(true);
    } finally { await m.close(); }
    const adaKey = await wsKey(w.admin.c);
    const ok = await v1(w, adaKey, "POST", "/data-moves/imports/run", { kind: "contacts", content: "BEGIN:VCARD\nFN:A\nEND:VCARD" });
    expect(ok.status).toBeLessThan(300);
  }, 120_000);
});
