import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { mailboxes, messages } from "@/server/db/schema";
import { getTableName } from "drizzle-orm";
import { STEP_CHUNKS, undoFor } from "@/server/services/mail/bulk-job-r33";

/** R33: "select all" as one server job (services/mail/bulk-job-r33.ts): chunks, mid job arrivals, undo, v1, MCP. */
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
const folderCount = async (folder: "inbox" | "archive") => (await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.folder, folder)).all()).length;

/** Counts UPDATE and INSERT statements per table while `fn` runs. */
async function countWrites<T>(fn: () => Promise<T>) {
  const db = ctx.deps.db as unknown as Record<"update" | "insert", (t: never) => unknown>;
  const counts: Record<string, number> = {};
  const wrap = (kind: "update" | "insert") => {
    const orig = db[kind].bind(db);
    db[kind] = (t: never) => { const k = `${kind}:${getTableName(t)}`; counts[k] = (counts[k] ?? 0) + 1; return orig(t); };
    return () => { db[kind] = orig; };
  };
  const undo = [wrap("update"), wrap("insert")];
  try { return { out: await fn(), counts }; } finally { undo.forEach((u) => u()); }
}

describe("select all as one server job", () => {
  it("archives everything in Inbox in steps of 900 (chunks of 90), leaves mail that arrived mid job alone, and Undo puts back exactly what it moved", async () => {
    const ids = await seedMany(950);
    const seenAt = new Date(Date.now() + 1000).toISOString(); // the newest arrival the person saw
    const body = { client_job_id: "job_select_all_1", action: "archive", scope: { mailboxId, folder: "inbox" }, exclude_ids: ids.slice(0, 3), max_received_at: seenAt };
    const first = await countWrites(() => owner.post("/api/mail/bulk-jobs", body));
    expect(first.out.status).toBe(200);
    expect(first.out.body).toMatchObject({ status: "running", total: 947, done: STEP_CHUNKS * 90, undoable: true });
    // One job row, one UPDATE per chunk of 90 messages, one job update per step.
    expect(first.counts["insert:mail_bulk_jobs"]).toBe(1);
    expect(first.counts["update:mail_bulk_jobs"]).toBe(1);
    expect(first.counts["update:messages"]).toBe(STEP_CHUNKS);

    // New mail lands mid job (after the ceiling): it must stay in Inbox.
    await ctx.deps.db.insert(messages).values({ id: "msg_late", orgId, mailboxId, folder: "inbox", threadId: "thr_late", fromAddress: "late@example.com", subject: "Late", date: new Date(now.getTime() - 10_000_000), createdAt: new Date(Date.parse(seenAt) + 5000) });

    // The same request again continues the job (idempotent by client_job_id).
    const second = await countWrites(() => owner.post("/api/mail/bulk-jobs", body));
    expect(second.out.body).toMatchObject({ status: "done", total: 947, done: 947 });
    expect(second.counts["insert:mail_bulk_jobs"]).toBeUndefined();
    expect(second.counts["update:messages"]).toBe(1);
    expect(await folderCount("archive")).toBe(947);
    expect(await folderCount("inbox")).toBe(4); // 3 unticked + the late arrival
    // Once done, repeating changes nothing.
    expect((await owner.post("/api/mail/bulk-jobs", body)).body).toMatchObject({ status: "done", done: 947 });

    // Undo in steps, by the server id.
    let u = (await owner.post(`/api/mail/bulk-jobs/${first.out.body.id}/undo`)).body;
    expect(u).toMatchObject({ status: "reverting", undoDone: 900, undoTotal: 947 });
    u = (await owner.post(`/api/mail/bulk-jobs/${first.out.body.id}/step`)).body;
    expect(u).toMatchObject({ status: "reverted", undoDone: 947 });
    expect(await folderCount("inbox")).toBe(951);
    expect((await owner.get(`/api/mail/bulk-jobs/job_select_all_1`)).body.status).toBe("reverted");
    // A reverted job doesn't run again.
    expect((await owner.post("/api/mail/bulk-jobs", body)).body.status).toBe("reverted");
  });

  it("Undo of mark read only flips back the ones it changed; a running job stops at Undo", async () => {
    await seedMany(1000, { read: (i) => i % 10 === 0 });
    const body = { client_job_id: "job_read_all_1", action: "read", scope: { mailboxId, folder: "inbox" }, max_received_at: Date.now() + 1000 };
    const r = (await owner.post("/api/mail/bulk-jobs", body)).body;
    expect(r).toMatchObject({ status: "running", done: 900, total: 1000 });
    // Undo while running: the last 100 are never touched.
    let u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/undo`)).body;
    expect(u.undoTotal).toBe(810); // 900 seen, 90 were already read
    while (u.status === "reverting") u = (await owner.post(`/api/mail/bulk-jobs/${r.id}/step`)).body;
    expect(u.status).toBe("reverted");
    const read = (await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.isRead, true)).all()).length;
    expect(read).toBe(100);
  });

  it("undoFor groups folder moves by where each message was", () => {
    expect(undoFor("archive", [{ id: "a", folder: "inbox", isRead: false, isStarred: false }, { id: "b", folder: "spam", isRead: false, isStarred: false }, { id: "c", folder: "archive", isRead: false, isStarred: false }]))
      .toEqual([{ action: "inbox", ids: ["a"] }, { action: "spam", ids: ["b"] }]);
    expect(undoFor("star", [{ id: "a", folder: "inbox", isRead: false, isStarred: true }, { id: "b", folder: "inbox", isRead: false, isStarred: false }])).toEqual([{ action: "unstar", ids: ["b"] }]);
  });

  it("list items carry receivedAt, and a job refuses another workspace's mailbox and bad bodies", async () => {
    await seedMany(2);
    const list = (await owner.get(`/api/mail/messages?mailboxId=${mailboxId}&folder=inbox`)).body.messages;
    expect(typeof list[0].receivedAt).toBe("string");
    const other = new Client(ctx.app);
    await other.signup("eve@evil.io", "Eve");
    const r = await other.post("/api/mail/bulk-jobs", { client_job_id: "job_evil_0001", action: "trash", scope: { mailboxId, folder: "inbox" }, max_received_at: Date.now() });
    expect(r.body.done ?? 0).toBe(0);
    expect(await folderCount("inbox")).toBe(2);
    expect((await owner.post("/api/mail/bulk-jobs", { client_job_id: "x", action: "archive", scope: { mailboxId }, max_received_at: 1 })).status).toBe(422);
    expect((await owner.post("/api/mail/bulk-jobs", { client_job_id: "job_delete_01", action: "delete", scope: { mailboxId }, max_received_at: 1 })).status).toBe(422);
  });

  it("works on v1 and MCP, and read only keys get 403", async () => {
    await seedMany(5);
    const key = (await owner.post("/api/developer/keys", { name: "Full" })).body.secret;
    const v1 = await api(key, "POST", "/mail/bulk-jobs", { client_job_id: "job_v1_00001", action: "archive", scope: { mailboxId, folder: "inbox" }, max_received_at: new Date(Date.now() + 1000).toISOString() });
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ status: "done", done: 5, total: 5 });
    expect((await api(key, "GET", `/mail/bulk-jobs/${v1.body.id}`)).body.status).toBe("done");
    expect((await api(key, "POST", `/mail/bulk-jobs/${v1.body.id}/undo`)).body.status).toBe("reverted");
    const mcp = await mcpFor(key);
    expect((await mcp.listTools()).tools.map((t) => t.name)).toContain("mail_bulk_job");
    const out = data(await mcp.callTool({ name: "mail_bulk_job", arguments: { job_id: "job_mcp_00001", action: "read", mailbox_id: mailboxId, folder: "inbox", max_received_at: new Date(Date.now() + 1000).toISOString() } }));
    expect(out).toMatchObject({ status: "done", done: 5 });
    expect(data(await mcp.callTool({ name: "mail_bulk_job", arguments: { job_id: "job_mcp_00001" } })).status).toBe("done");
    expect(data(await mcp.callTool({ name: "mail_bulk_job", arguments: { job_id: "job_mcp_00001", undo: true } })).status).toBe("reverted");
    await mcp.close();
    const ro = (await owner.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    expect((await api(ro, "POST", "/mail/bulk-jobs", { client_job_id: "job_ro_000001", action: "archive", scope: { mailboxId }, max_received_at: 1 })).status).toBe(403);
  });
});
