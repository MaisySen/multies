import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { mailboxes, mailConnections, mailSyncOutbox, messages } from "@/server/db/schema";
import { undoFor } from "@/server/services/mail/bulk-job-r33";
import { mailSchedules } from "@/server/db/schema";

/** R34: snooze, move and delete (to trash) in "everything" mode as the same server job, with exact Undo. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
let orgId: string;
let now = new Date("2026-10-26T03:00:00Z");

async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);


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


/** Fast seed: n inbox messages, newest first, in inserts of 3 rows (D1's 100 variable limit; every column binds). */
async function seedMany(n: number, opts: { read?: (i: number) => boolean } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `msg_seed_${String(i).padStart(5, "0")}`, orgId, mailboxId, folder: "inbox" as const, threadId: `thr_${i}`,
    fromAddress: `p${i}@example.com`, subject: `Note ${i}`, date: new Date(now.getTime() - i * 1000), isRead: opts.read ? opts.read(i) : false,
  }));
  for (let i = 0; i < rows.length; i += 3) await ctx.deps.db.insert(messages).values(rows.slice(i, i + 3));
  return rows.map((r) => r.id);
}
const folderCount = async (folder: "inbox" | "archive" | "trash") => (await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.folder, folder)).all()).length;


const snoozes = async () => (await ctx.deps.db.select({ id: mailSchedules.id }).from(mailSchedules).where(eq(mailSchedules.kind, "snooze")).all()).length;
const seen = () => new Date(Date.now() + 1000).toISOString();

describe("R34: snooze, move and delete over everything", () => {
  it("snoozes every Inbox thread with one time, hides them from Inbox, and Undo clears the snooze", async () => {
    const ids = await seedMany(950);
    const body = { client_job_id: "job_snooze_all1", action: "snooze", scope: { mailboxId, folder: "inbox" }, exclude_ids: ids.slice(0, 2), when: { at: "2026-10-27T09:00:00Z" }, max_received_at: seen() };
    let r = (await owner.post("/api/mail/bulk-jobs", body)).body;
    expect(r).toMatchObject({ status: "running", total: 948, done: 900, undoable: true });
    r = (await owner.post("/api/mail/bulk-jobs", body)).body;
    expect(r).toMatchObject({ status: "done", done: 948, undoTotal: 948 });
    expect(await snoozes()).toBe(948);
    const due = await ctx.deps.db.select({ d: mailSchedules.dueAt }).from(mailSchedules).all();
    expect(new Set(due.map((x) => x.d.toISOString()))).toEqual(new Set(["2026-10-27T09:00:00.000Z"]));
    const list = (await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox`)).body.messages;
    expect(list.map((m: { id: string }) => m.id).sort()).toEqual(ids.slice(0, 2).sort());
    let u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/undo`)).body;
    while (u.status === "reverting") u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/step`)).body;
    expect(u.status).toBe("reverted");
    expect(await snoozes()).toBe(0);
  });

  it("refuses a snooze with no time and a move with no folder", async () => {
    await seedMany(3);
    expect((await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_snooze_bad", action: "snooze", scope: { mailboxId, folder: "inbox" }, max_received_at: seen() })).status).toBe(400);
    expect((await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_move_bad01", action: "move", scope: { mailboxId, folder: "inbox" }, max_received_at: seen() })).status).toBe(400);
    expect(await snoozes()).toBe(0);
  });

  it("delete in everything mode is a move to Trash and Undo puts each message back where it was", async () => {
    await seedMany(200);
    await ctx.deps.db.update(messages).set({ folder: "archive" }).where(eq(messages.id, "msg_seed_00007"));
    const r = (await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_trash_all1", action: "trash", scope: { mailboxId, q: "note" }, max_received_at: seen() })).body;
    expect(r).toMatchObject({ status: "done", done: 200 });
    expect(await folderCount("trash")).toBe(200);
    let u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/undo`)).body;
    while (u.status === "reverting") u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/step`)).body;
    expect(await folderCount("inbox")).toBe(199);
    expect(await folderCount("archive")).toBe(1);
  });

  it("a move skips mail that isn't synced from a connected mailbox (nothing to undo then)", async () => {
    await seedMany(5);
    const r = (await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_move_all01", action: "move", to: "f:Projects", scope: { mailboxId, folder: "inbox" }, max_received_at: seen() })).body;
    expect(r).toMatchObject({ status: "done", done: 5, undoable: false });
    expect(await folderCount("inbox")).toBe(5);
    expect(undoFor("move", [{ id: "a", folder: "inbox", isRead: false, isStarred: false, remoteBox: null, remoteUid: null }], { to: "f:Projects" })).toEqual([]);
    expect(undoFor("snooze", [{ id: "a", folder: "inbox", isRead: false, isStarred: false, remoteBox: null, remoteUid: null }, { id: "b", folder: "drafts", isRead: false, isStarred: false, remoteBox: null, remoteUid: null }])).toEqual([{ action: "unsnooze", ids: ["a"] }]);
  });

  it("R35: the undo plan of a move remembers where each synced message came from", () => {
    const row = (id: string, remoteBox: string | null, remoteUid: number | null, folder: "inbox" | "archive" | "sent" = "inbox") => ({ id, folder, isRead: false, isStarred: false, remoteBox, remoteUid });
    expect(undoFor("move", [row("a", "inbox", 11), row("b", "f:Old", 7, "archive"), row("c", "inbox", 12), row("d", "f:Projects", 3, "archive"), row("e", "inbox", null), row("s", "sent", 9, "sent")], { to: "f:Projects" })).toEqual([
      { action: "move", ids: ["a", "c"], to: "inbox", folder: "inbox", uids: [11, 12] },
      { action: "move", ids: ["b"], to: "f:Old", folder: "archive", uids: [7] },
    ]);
  });

  it("takes thousands of unticked ids (kept on the job, one bound variable in SQL)", async () => {
    await seedMany(10);
    const exclude = [...Array.from({ length: 6000 }, (_, i) => `msg_none_${i}`), "msg_seed_00000"];
    const r = await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_many_excl1", action: "archive", scope: { mailboxId, folder: "inbox" }, exclude_ids: exclude, max_received_at: seen() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "done", done: 9 });
  });

  it("MCP mail_bulk_job snoozes everything with snooze_until", async () => {
    await seedMany(4);
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const mcp = await mcpFor(key);
    const out = data(await mcp.callTool({ name: "mail_bulk_job", arguments: { job_id: "job_mcp_snooze1", action: "snooze", mailbox_id: mailboxId, folder: "inbox", snooze_until: "2026-10-28T09:00:00Z", max_received_at: seen() } }));
    expect(out).toMatchObject({ status: "done", done: 4 });
    expect(await snoozes()).toBe(4);
    await mcp.close();
  });
});

describe("R35: Undo of a move over everything", () => {
  async function seedSynced(n: number) {
    await ctx.deps.db.insert(mailConnections).values({ id: "conn_r35", orgId, mailboxId, provider: "imap", email: "hello@acme.io", username: "hello@acme.io", imapHost: "imap.example.com", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example.com", smtpPort: 465, smtpSecurity: "tls", secretEnc: "x", syncState: JSON.stringify({ paths: { inbox: "INBOX", archive: "Archive" }, extra: ["Projects"] }) });
    const ids = await seedMany(n);
    for (const [i, id] of ids.entries()) await ctx.deps.db.update(messages).set({ remoteBox: "inbox", remoteUid: 100 + i }).where(eq(messages.id, id));
    return ids;
  }
  const rowsNow = async () => (await ctx.deps.db.select({ id: messages.id, folder: messages.folder, remoteBox: messages.remoteBox, remoteUid: messages.remoteUid }).from(messages).orderBy(messages.id).all());
  const outbox = async () => await ctx.deps.db.select().from(mailSyncOutbox).all();

  it("takes back a move the provider has not run yet: queued changes dropped, old folder and UIDs back", async () => {
    const ids = await seedSynced(4);
    const r = (await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_move_r35a", action: "move", to: "f:Projects", scope: { mailboxId, folder: "inbox" }, max_received_at: seen() })).body;
    expect(r).toMatchObject({ status: "done", done: 4, undoable: true, undoTotal: 4 });
    expect((await rowsNow()).every((m) => m.folder === "archive" && m.remoteBox === "f:Projects" && m.remoteUid === null)).toBe(true);
    expect(await outbox()).toHaveLength(4);
    let u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/undo`, {})).body;
    while (u.status === "reverting") u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/step`, {})).body;
    expect(u.status).toBe("reverted");
    expect(await outbox()).toHaveLength(0);
    const back = await rowsNow();
    expect(back.map((m) => [m.id, m.folder, m.remoteBox, m.remoteUid])).toEqual(ids.map((id, i) => [id, "inbox", "inbox", 100 + i]).sort());
  });

  it("moves back through the provider once it has run the move", async () => {
    await seedSynced(3);
    const r = (await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_move_r35b", action: "move", to: "f:Projects", scope: { mailboxId, folder: "inbox" }, max_received_at: seen() })).body;
    // The provider ran it: the queue is empty and each message has its new UID in Projects.
    await ctx.deps.db.delete(mailSyncOutbox);
    const moved = await rowsNow();
    for (const [i, m] of moved.entries()) await ctx.deps.db.update(messages).set({ remoteUid: 500 + i }).where(eq(messages.id, m.id));
    let u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/undo`, {})).body;
    while (u.status === "reverting") u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/step`, {})).body;
    expect(u.status).toBe("reverted");
    const q = await outbox();
    expect(q).toHaveLength(3);
    expect(q.every((o) => o.action === "move" && o.dest === "inbox" && o.remoteBox === "f:Projects")).toBe(true);
    expect((await rowsNow()).every((m) => m.folder === "inbox" && m.remoteBox === "inbox")).toBe(true);
  });
});
