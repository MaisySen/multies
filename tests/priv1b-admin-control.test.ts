/**
 * PRIV1b admin-control: what an admin (or a low share) can still change on someone's personal mailbox.
 * P7 name and Reply-To, P23 the mailbox list, P5/P62 reconnect, P14/P46 connection routes and live mail,
 * P12 imports and Undo. App passwords (P6, P42) are in priv1b-admin-control-apppw.test.ts.
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privacyWorld } from "./priv1a-world";
import { FakeImapServer, FakeSmtpServer } from "./fake-mail-servers";
import { toBase64, splitMbox } from "@/web/lib/mbox-r40";
import { mailConnections, mailboxes, members, messages } from "@/server/db/schema";

const GMAIL = "pat.gmail@gmail.com";

async function mcpFor(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const PW = "abcd efgh ijkl mnop";

describe("PRIV1b (P7) a personal mailbox's name and Reply-To", () => {
  it("only its owner sets them; admins keep quota; team mailboxes stay admin only", async () => {
    const w = await privacyWorld();
    const p = w.boxes.personal;
    // S3: people who can't open it get 404, as everywhere else in PRIV1a; a share gets 403.
    const ada = await w.admin.c.patch(`/api/mailboxes/${p}`, { replyTo: "ada@evil.example" });
    expect(ada.status).toBe(404);
    expect((await w.admin.c.patch(`/api/mailboxes/${p}`, { displayName: "Not Pat" })).status).toBe(404);
    expect((await w.owner.patch(`/api/mailboxes/${p}`, { replyTo: "olive@evil.example" })).status).toBe(404);
    expect((await w.nobody.c.patch(`/api/mailboxes/${p}`, { replyTo: "nia@evil.example" })).status).toBe(404);
    expect((await w.dRead.c.patch(`/api/mailboxes/${p}`, { replyTo: "rae@evil.example" })).status).toBe(403);
    // S1: an empty patch is a 422, not a 500.
    const empty = await w.pat.c.patch(`/api/mailboxes/${p}`, {});
    expect(empty.status).toBe(422);
    expect((await w.member.c.patch(`/api/mailboxes/${w.boxes.team}`, {})).status).toBe(422);
    // A send as share is not ownership.
    expect((await w.dSend.c.patch(`/api/mailboxes/${p}`, { replyTo: "sam@evil.example" })).status).toBe(403);
    let row = (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, p)).get())!;
    expect(row.replyTo).toBeNull();
    expect(row.displayName).toBe("Pat (connected)");
    // Pat, a plain member, sets her own.
    const mine = await w.pat.c.patch(`/api/mailboxes/${p}`, { replyTo: "pat.replies@acme.io", displayName: "Pat P" });
    expect(mine.status).toBe(200);
    expect(mine.body.mailbox.replyTo).toBe("pat.replies@acme.io");
    // ...but not the quota or status, which stay with admins.
    expect((await w.pat.c.patch(`/api/mailboxes/${p}`, { quotaMb: 50 })).status).toBe(403);
    expect((await w.pat.c.patch(`/api/mailboxes/${p}`, { status: "suspended" })).status).toBe(403);
    expect((await w.admin.c.patch(`/api/mailboxes/${p}`, { quotaMb: 50 })).status).toBe(200);
    row = (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, p)).get())!;
    expect(row.replyTo).toBe("pat.replies@acme.io");
    expect(row.quotaMb).toBe(50);
    // Team mailbox: admins as before, members not.
    expect((await w.admin.c.patch(`/api/mailboxes/${w.boxes.team}`, { replyTo: "support@acme.io" })).status).toBe(200);
    expect((await w.member.c.patch(`/api/mailboxes/${w.boxes.team}`, { replyTo: "max@evil.example" })).status).toBe(403);
    // v1 and MCP go through the same rule: an admin's workspace key can't set Pat's Reply-To.
    const key = (await w.admin.c.post("/api/developer/keys", { name: "ops" })).body.secret as string;
    const v1 = await w.ctx.app.request(`/api/v1/mailboxes/${p}`, { method: "PATCH", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ replyTo: "ada@evil.example" }) });
    expect(v1.status).toBe(404);
    // S4: the MCP tool on the same key fails the same way.
    const mcp = await mcpFor(w.ctx.app, key);
    const r = await mcp.callTool({ name: "set_mailbox_reply_to", arguments: { mailboxId: p, replyTo: "ada@evil.example" } });
    expect(r.isError).toBe(true);
    const rt = await mcp.callTool({ name: "set_mailbox_reply_to", arguments: { mailboxId: w.boxes.team, replyTo: "ops@acme.io" } });
    expect(rt.isError).toBeFalsy();
    await mcp.close();
    const v1Team = await w.ctx.app.request(`/api/v1/mailboxes/${w.boxes.team}`, { method: "PATCH", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ replyTo: "help@acme.io" }) });
    expect(v1Team.status).toBe(200);
    expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, w.boxes.team)).get())!.replyTo).toBe("help@acme.io");
    expect((await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, p)).get())!.replyTo).toBe("pat.replies@acme.io");
  }, 120_000);
});

describe("PRIV1b (P23) GET /api/mailboxes", () => {
  it("members get their scope; admins get personal mailboxes they can't open reduced, with openable", async () => {
    const w = await privacyWorld();
    const ids = (b: { mailboxes: { id: string }[] }) => b.mailboxes.map((m) => m.id);
    const nia = await w.nobody.c.get("/api/mailboxes");
    expect(nia.status).toBe(200);
    expect(ids(nia.body)).not.toContain(w.boxes.personal);
    expect(ids(nia.body)).not.toContain(w.boxes.team);
    const max = await w.member.c.get("/api/mailboxes");
    expect(ids(max.body)).toEqual([w.boxes.team]);
    expect(max.body.mailboxes[0].openable).toBe(true);
    const pat = await w.pat.c.get("/api/mailboxes");
    const own = pat.body.mailboxes.find((m: { id: string }) => m.id === w.boxes.personal);
    expect(own.openable).toBe(true);
    expect(own.usedBytes).toBeDefined();
    const rae = await w.dRead.c.get("/api/mailboxes");
    expect(ids(rae.body)).toContain(w.boxes.personal);
    const ada = await w.admin.c.get("/api/mailboxes");
    const team = ada.body.mailboxes.find((m: { id: string }) => m.id === w.boxes.team);
    expect(team.openable).toBe(true);
    expect(team.usedBytes).toBeDefined();
    const reduced = ada.body.mailboxes.find((m: { id: string }) => m.id === w.boxes.personal);
    expect(reduced).toEqual({ id: w.boxes.personal, address: `pat.private${w.n}@acme.io`, displayName: "Pat (connected)", personal: true, ownerUserId: w.pat.id, status: "active", openable: false });
    // M2: the v1 list on an admin's key leaves Pat's mailbox out (it is the full shape, Reply-To included).
    await w.ctx.db.update(mailboxes).set({ replyTo: "pat.replies@acme.io" }).where(eq(mailboxes.id, w.boxes.personal));
    const v1 = async (key: string) => (await (await w.ctx.app.request("/api/v1/mailboxes", { headers: { authorization: `Bearer ${key}` } })).json()) as { data: { id: string }[] };
    const adaKey = (await w.admin.c.post("/api/developer/keys", { name: "ops" })).body.secret as string;
    const adaV1 = await v1(adaKey);
    expect(adaV1.data.map((m) => m.id)).toContain(w.boxes.team);
    expect(adaV1.data.map((m) => m.id)).not.toContain(w.boxes.personal);
    expect(JSON.stringify(adaV1)).not.toContain("pat.replies@acme.io");
  }, 120_000);
});

async function connectedWorld() {
  const w = await privacyWorld();
  const imap = new FakeImapServer().addAccount(GMAIL, PW, { sentPath: "[Gmail]/Sent Mail" }).addAccount("evil", "evilpw");
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(GMAIL, PW);
  smtp.accounts.set("evil", "evilpw");
  w.ctx.deps.imap = (s, a, o) => imap.connector(s, a, o);
  w.ctx.deps.openSocket = (opts) => smtp.opener(opts);
  const made = await w.pat.c.post("/api/connections", { email: GMAIL, password: PW });
  expect(made.status).toBe(201);
  const conn = made.body.connection as { id: string; mailboxId: string };
  for (const [who, level] of [[w.dRead, "read"], [w.dReply, "reply"]] as const) {
    expect((await w.pat.c.put(`/api/mailboxes/${conn.mailboxId}/sharing/${who.id}`, { level })).status).toBe(200);
  }
  return { ...w, conn };
}

describe("PRIV1b (P5, P62) reconnecting a personal connection", () => {
  it("an admin can't repoint it; the owner can; the connector who isn't the owner can't; admins can still remove it", async () => {
    const w = await connectedWorld();
    const id = w.conn.id;
    const evil = { password: "evilpw", username: "evil", imap: { host: "imap.attacker-mail.com" }, smtp: { host: "smtp.attacker-mail.com" } };
    expect((await w.admin.c.put(`/api/connections/${id}`, evil)).status).toBe(403);
    expect((await w.owner.put(`/api/connections/${id}`, evil)).status).toBe(403);
    // A send as share is not ownership either (Sam has none here; Rex has reply).
    expect((await w.dReply.c.put(`/api/connections/${id}`, evil)).status).toBe(403);
    let row = (await w.ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())!;
    expect(row.smtpHost).not.toContain("attacker");
    // P62: whoever connected it no longer decides once the mailbox is someone else's.
    await w.ctx.db.update(mailConnections).set({ createdByUserId: w.nobody.id }).where(eq(mailConnections.id, id));
    expect((await w.nobody.c.put(`/api/connections/${id}`, evil)).status).toBe(403);
    expect((await w.nobody.c.del(`/api/connections/${id}`)).status).toBe(403);
    // The owner reconnects.
    const ok = await w.pat.c.put(`/api/connections/${id}`, { password: PW });
    expect(ok.status).toBe(200);
    row = (await w.ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())!;
    expect(row.smtpHost).toBe("smtp.gmail.com");
    // Admins can still remove it.
    expect((await w.admin.c.del(`/api/connections/${id}`)).status).toBe(200);
  }, 120_000);

  it("an orphaned personal connection is changed by the workspace owner only", async () => {
    const w = await connectedWorld();
    await w.ctx.db.update(mailboxes).set({ ownerUserId: null }).where(eq(mailboxes.id, w.conn.mailboxId));
    expect((await w.admin.c.put(`/api/connections/${w.conn.id}`, { password: PW })).status).toBe(403);
    expect((await w.owner.put(`/api/connections/${w.conn.id}`, { password: PW })).status).toBe(200);
  }, 120_000);
});

describe("PRIV1b (P14, P46) connection routes follow the mailbox", () => {
  it("folders need the mailbox open; sync, older mail and folder choice need a reply share; lists and live keep to scope", async () => {
    const w = await connectedWorld();
    const id = w.conn.id;
    // Folders: the list signs in to Pat's account.
    expect((await w.nobody.c.get(`/api/connections/${id}/folders`)).status).toBe(404);
    expect((await w.admin.c.get(`/api/connections/${id}/folders`)).status).toBe(404);
    expect((await w.owner.get(`/api/connections/${id}/folders`)).status).toBe(404);
    const raeFolders = await w.dRead.c.get(`/api/connections/${id}/folders`);
    expect(raeFolders.status).toBe(200);
    expect(raeFolders.body.folders.length).toBeGreaterThan(0);
    expect((await w.pat.c.get(`/api/connections/${id}/folders`)).status).toBe(200);
    // Sync and older mail.
    expect((await w.nobody.c.post(`/api/connections/${id}/sync`, {})).status).toBe(404);
    expect((await w.admin.c.post(`/api/connections/${id}/sync`, {})).status).toBe(404);
    expect((await w.dRead.c.post(`/api/connections/${id}/sync`, {})).status).toBe(403);
    expect((await w.dReply.c.post(`/api/connections/${id}/sync`, {})).status).toBe(200);
    expect((await w.pat.c.post(`/api/connections/${id}/sync`, {})).status).toBe(200);
    expect((await w.nobody.c.post(`/api/connections/${id}/backfill`, { paused: true })).status).toBe(404);
    expect((await w.dRead.c.post(`/api/connections/${id}/backfill`, { paused: true })).status).toBe(403);
    const paused = await w.pat.c.post(`/api/connections/${id}/backfill`, { paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body.connection.id).toBe(id);
    expect((await w.dRead.c.put(`/api/connections/${id}/folders`, { path: "INBOX", sync: true })).status).toBe(403);
    expect((await w.admin.c.put(`/api/connections/${id}/folders`, { path: "INBOX", sync: true })).status).toBe(404);
    // The list: Nia gets nothing, Ada only the reduced row, Pat and Rae the full one.
    const nia = await w.nobody.c.get("/api/connections");
    expect(nia.body.connections).toEqual([]);
    const ada = await w.admin.c.get("/api/connections");
    expect(ada.body.connections).toEqual([{ id, mailboxId: w.conn.mailboxId, email: GMAIL, status: expect.any(String), openable: false }]);
    expect(JSON.stringify(ada.body)).not.toContain("imap.gmail.com");
    const pat = await w.pat.c.get("/api/connections");
    expect(pat.body.connections[0]).toMatchObject({ id, openable: true, imapHost: "imap.gmail.com" });
    expect((await w.dRead.c.get("/api/connections")).body.connections[0].openable).toBe(true);
    // Live: only connections the caller can open.
    const niaLive = await w.nobody.c.post("/api/connections/live", {});
    expect(niaLive.status).toBe(200);
    expect(niaLive.body.connections).toEqual([]);
    expect((await w.admin.c.post("/api/connections/live", {})).body.connections).toEqual([]);
    // P46: five newer connections of someone else don't push Pat's out of her own live list.
    const base = (await w.ctx.db.select().from(mailConnections).where(eq(mailConnections.id, id)).get())!;
    for (let i = 0; i < 5; i++) {
      const mbx = `mbx_adaconn${i}${w.n}0000000`;
      await w.ctx.db.insert(mailboxes).values({ id: mbx, orgId: w.orgId, domainId: w.domainId, localPart: `ada.c${i}`, address: `ada.c${i}.${w.n}@gmail.com`, displayName: "Ada", quotaMb: 100, personal: true, ownerUserId: w.admin.id });
      await w.ctx.db.insert(mailConnections).values({ ...base, id: `mcn_ada${i}${w.n}0000000`, mailboxId: mbx, email: `ada.c${i}.${w.n}@gmail.com`, createdByUserId: w.admin.id, status: "active", createdAt: new Date(Date.now() + 60_000 * (i + 1)) });
    }
    const patLive = await w.pat.c.post("/api/connections/live", {});
    expect(patLive.body.connections.map((x: { id: string }) => x.id)).toEqual([id]);
    const adaLive = await w.admin.c.post("/api/connections/live", {});
    expect(adaLive.body.connections).toHaveLength(5);
    expect(adaLive.body.connections.map((x: { id: string }) => x.id)).not.toContain(id);
  }, 120_000);

  it("a team mailbox connection keeps the old rule: its connector or an admin", async () => {
    const w = await connectedWorld();
    // As a workspace key would leave it: a team mailbox, granted to Max.
    await w.ctx.db.update(mailboxes).set({ personal: false, ownerUserId: null }).where(eq(mailboxes.id, w.conn.mailboxId));
    expect((await w.admin.c.get(`/api/connections/${w.conn.id}/folders`)).status).toBe(200);
    expect((await w.admin.c.post(`/api/connections/${w.conn.id}/sync`, {})).status).toBe(200);
    expect((await w.admin.c.put(`/api/connections/${w.conn.id}`, { password: PW })).status).toBe(200);
    expect((await w.nobody.c.get(`/api/connections/${w.conn.id}/folders`)).status).toBe(404);
  }, 120_000);
});

const rawMsg = (id: string, subject: string) =>
  `Message-ID: <${id}@old.example>\r\nFrom: Old Friend <friend@old.example>\r\nTo: me@acme.io\r\nSubject: ${subject}\r\nDate: Tue, 1 Sep 2026 09:00:00 +1000\r\nContent-Type: text/plain\r\n\r\nHello from the archive.\r\n`;
const mbox = (ids: string[]) => splitMbox(new TextEncoder().encode(ids.map((id) => `From a@x Mon Sep  1 09:00:00 2026\r\n${rawMsg(id, `Archive ${id}`)}`).join("\r\n"))).map(toBase64);

describe("PRIV1b (P12) imports into a personal mailbox", () => {
  it("IMAP import and mbox import need Send as; Undo on a personal target needs Send as or the run's creator", async () => {
    const w = await privacyWorld();
    const { ctx, orgId } = w;
    (ctx.deps.config as { importRunnerToken?: string }).importRunnerToken = "r".repeat(32);
    // Imports need an admin: Rae (read share) and Pat are admins here.
    for (const u of [w.dRead.id, w.pat.id]) await ctx.db.update(members).set({ role: "admin" }).where(and(eq(members.organizationId, orgId), eq(members.userId, u)));
    const imap = { provider: "imap", sourceUser: "drop", appPassword: "pw-pw-pw", sourceHost: "imap.attacker-mail.net" };
    expect((await w.admin.c.post("/api/imports", { mailboxId: w.boxes.personal, ...imap })).status).toBe(404);
    expect((await w.dRead.c.post("/api/imports", { mailboxId: w.boxes.personal, ...imap })).status).toBe(403);
    expect((await w.admin.c.post("/api/imports", { mailboxId: w.boxes.team, ...imap })).status).toBe(201);
    expect((await w.pat.c.post("/api/imports", { mailboxId: w.boxes.personal, ...imap })).status).toBe(201);
    // mbox: Rae's read share can't write mail in.
    const rae = await w.dRead.c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: w.boxes.personal, total: 1, last: true, messages: mbox(["fake1"]) }, { "idempotency-key": "mbox_priv1b_rae_0001" });
    expect(rae.status).toBe(403);
    expect(await ctx.db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.subject, "Archive fake1"))).all()).toHaveLength(0);
    const run = await w.pat.c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: w.boxes.personal, total: 2, fileName: "pat-old.mbox", last: true, messages: mbox(["p1", "p2"]) }, { "idempotency-key": "mbox_priv1b_pat_00001" });
    expect(run.status).toBe(200);
    const archived = () => ctx.db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, w.boxes.personal), eq(messages.subject, "Archive p1"))).all();
    expect(await archived()).toHaveLength(1);
    // Ada (can't open it) and Rae (read) can't undo Pat's import; Pat can.
    expect((await w.admin.c.post(`/api/data-moves/${run.body.move.id}/undo`, {})).status).toBe(404);
    expect((await w.dRead.c.post(`/api/data-moves/${run.body.move.id}/undo`, {})).status).toBe(403);
    expect(await archived()).toHaveLength(1);
    const undo = await w.pat.c.post(`/api/data-moves/${run.body.move.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(await archived()).toHaveLength(0);
    // Team mailbox: another admin still undoes an import.
    const teamRun = await w.owner.call("POST", "/api/data-moves/mbox/batch", { mailboxId: w.boxes.team, total: 1, last: true, messages: mbox(["t1"]) }, { "idempotency-key": "mbox_priv1b_team_0001" });
    expect(teamRun.status).toBe(200);
    expect((await w.admin.c.post(`/api/data-moves/${teamRun.body.move.id}/undo`, {})).status).toBe(200);
  }, 120_000);
});

describe("PRIV1b (P62, S2) a personal connection's calendar", () => {
  it("follows the mailbox owner, not whoever connected it", async () => {
    const w = await connectedWorld();
    const id = w.conn.id;
    await w.ctx.db.update(mailConnections).set({ createdByUserId: w.nobody.id }).where(eq(mailConnections.id, id));
    // Nia connected it but it is Pat's: Nia isn't offered it and can't add it with Pat's stored password.
    expect((await w.nobody.c.get("/api/calendar/sources/options")).body.data).toEqual([]);
    const nia = await w.nobody.c.post("/api/calendar/sources", { kind: "caldav", connectionId: id });
    expect(nia.status).toBe(403);
    expect((await w.admin.c.post("/api/calendar/sources", { kind: "caldav", connectionId: id })).status).toBe(403);
    // Pat is offered it; Gmail's calendar needs OAuth, so adding stops there (not at the owner check).
    const opts = (await w.pat.c.get("/api/calendar/sources/options")).body.data as { connectionId: string }[];
    expect(opts.map((o) => o.connectionId)).toEqual([id]);
    const pat = await w.pat.c.post("/api/calendar/sources", { kind: "caldav", connectionId: id });
    expect(pat.status).toBe(422);
    expect(pat.body.error.code).toBe("caldav_needs_oauth");
  }, 120_000);
});
