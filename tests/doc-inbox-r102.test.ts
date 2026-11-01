import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { runDocPass, canAddFromMailbox, excludedOrg } from "@/server/services/suite/doc-inbox";
import { searchR98 } from "@/server/services/search-r98";

/** R102 Smart document inbox: reading, fields, rules, views, caps, vv8k and every permission path. Made up documents only. */
const INVOICE = "Harbour Supplies Pty Ltd\nTAX INVOICE\nInvoice date: 1/11/2026\nDue date: 15 Nov 2026\nGST $180.00\nAmount due $1,980.00";
const PDF_TEXT = "Bright Sparks Electrical\nABN 12 345 678 901\nTAX INVOICE\nInvoice date 2 Nov 2026\nTotal due $412.50\nGST $37.50";
const ENGINE = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "k1", DOC_ENGINE_KEY: "e".repeat(48), TOOLS_TOKEN_KEY: "t".repeat(40) };

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let orgId: string;
let jobs: Map<string, string>;
let engineCalls: number;

const engineFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (method === "POST" && url.pathname === "/internal/v1/jobs") { engineCalls++; const id = `job${jobs.size + 1}abcdef`; jobs.set(id, PDF_TEXT); return json({ id }); }
  const m = /^\/internal\/v1\/jobs\/([^/]+)(\/output)?$/.exec(url.pathname);
  if (m && method === "DELETE") return json({ ok: true });
  if (m && m[2]) return json({ pages: [{ page: 1, text: jobs.get(m[1]) ?? "", ocr: true }] });
  if (m) return json({ status: jobs.has(m[1]) ? "done" : "failed" });
  return json({ error: "nope" }, 404);
}) as typeof fetch;

async function setup(env: Record<string, string> = {}, name = "Acme") {
  ctx = await makeTestApp({ FILES_PLUS_R101: "on", DOC_INBOX_R102: "on", ...ENGINE, ...env }, { fetch: engineFetch });
  ctx.deps.now = () => new Date("2026-11-01T01:00:00Z");
  jobs = new Map(); engineCalls = 0;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  if (name !== "Acme") await ctx.db.run(sql`update organizations set name = ${name} where id = ${orgId}`);
}
async function teammate(email: string, role: "member" | "admin" = "member") {
  const invite = await owner.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, email.split("@")[0], "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
async function upload(c: Client, name: string, body: string | Uint8Array, q: Record<string, string> = {}, type = "text/plain") {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const res = await ctx.app.request(`/api/drive/upload?${new URLSearchParams({ space: "team", name, ...q })}`, { method: "PUT", headers: { cookie: c.cookie, host: "localhost", "content-type": type, "x-multies-upload": "1" }, body: bytes as BodyInit });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()).item as { id: string };
}
const docs = async (c: Client, view = "all", q = "") => (await c.get(`/api/doc-inbox/list?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ""}`));

describe("R102 flag and sessions", () => {
  it("is off without the flag, and needs a workspace session", async () => {
    await setup({ DOC_INBOX_R102: "off" });
    expect((await docs(owner)).status).toBe(404);
    expect((await owner.get("/api/config")).body.docInbox).toBe(false);
    await setup();
    expect((await owner.get("/api/config")).body.docInbox).toBe(true);
    const anon = new Client(ctx.app);
    expect((await docs(anon)).status).toBe(401);
  });
});

describe("R102 reading and fields", () => {
  beforeEach(() => setup());
  it("reads a text upload, detects fields, keeps the text, lists it to check", async () => {
    const it0 = await upload(owner, "harbour.txt", INVOICE);
    const l = await docs(owner, "check");
    expect(l.status).toBe(200);
    expect(l.body.items).toHaveLength(1);
    expect(l.body.items[0]).toMatchObject({ id: it0.id, status: "done", checked: false, fields: { type: "bill", sender: "Harbour Supplies Pty Ltd", docDate: "2026-11-01", dueDate: "2026-11-15", amount: 198000, gst: 18000, paid: false } });
    expect(l.body.counts).toMatchObject({ check: 1, all: 1, unpaid: 1, bills: 1, tax: 0 });
    const d = await owner.get(`/api/doc-inbox/items/${it0.id}`);
    expect(d.body.text).toContain("TAX INVOICE");
    expect((await docs(owner, "unpaid")).body.items).toHaveLength(1);
  });
  it("reads a PDF through the engine (reading, then done on the next look)", async () => {
    const pdf = await upload(owner, "sparks.pdf", "%PDF-1.4 fake", {}, "application/pdf");
    const first = await docs(owner, "all");
    expect(engineCalls).toBe(1);
    expect(["reading", "done"]).toContain(first.body.items[0].status);
    const d = await owner.get(`/api/doc-inbox/items/${pdf.id}`);
    expect(d.body).toMatchObject({ status: "done", fields: { sender: "Bright Sparks Electrical", amount: 41250, gst: 3750, docDate: "2026-11-02" } });
  });
  it("full text search finds words inside documents", async () => {
    await upload(owner, "harbour.txt", INVOICE);
    await upload(owner, "note.txt", "Just a note about lunch");
    await docs(owner);
    const s = await docs(owner, "all", "harbour supplies");
    expect(s.body.items.map((x: { name: string }) => x.name)).toEqual(["harbour.txt"]);
    expect(s.body.items[0].snippet).toMatch(/Harbour/i);
  });
  it("a corrected field stays corrected; checked leaves To check", async () => {
    const it0 = await upload(owner, "harbour.txt", INVOICE);
    await docs(owner);
    const p = await owner.patch(`/api/doc-inbox/items/${it0.id}`, { sender: "Harbour", amount: 200000, paid: true, checked: true });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ fields: { sender: "Harbour", amount: 200000, paid: true }, checked: true });
    expect(p.body.edited.sort()).toEqual(["amount", "paid", "sender"]);
    expect((await docs(owner, "check")).body.items).toHaveLength(0);
    expect((await docs(owner, "unpaid")).body.items).toHaveLength(0);
    // Reading again keeps what the person corrected.
    const again = await owner.post(`/api/doc-inbox/items/${it0.id}/read`);
    expect(again.body.fields).toMatchObject({ sender: "Harbour", amount: 200000, paid: true, gst: 18000 });
    expect((await owner.patch(`/api/doc-inbox/items/${it0.id}`, { docDate: "1/11/2026" })).status).toBe(422);
    expect((await owner.patch(`/api/doc-inbox/items/${it0.id}`, { amount: -5 })).status).toBe(422);
  });
  it("files that cannot be read are kept as skipped, and brand library files are not added", async () => {
    await upload(owner, "song.mp3", "ID3", {}, "audio/mpeg");
    await upload(owner, "logo.txt", "brand words", { space: "brand" });
    const l = await docs(owner);
    expect(l.body.items.map((x: { name: string; status: string }) => [x.name, x.status])).toEqual([["song.mp3", "skipped"]]);
  });
});

describe("R102 permissions", () => {
  beforeEach(() => setup());
  it("a private file's text, fields and hits are only for people who can open it", async () => {
    const bob = await teammate("bob@acme.io");
    const ann = await teammate("ann@acme.io", "admin");
    const mine = await upload(owner, "private-bill.txt", INVOICE, { space: "private" });
    await docs(owner);
    for (const c of [bob.client, ann.client]) {
      expect((await docs(c)).body.items).toHaveLength(0);
      expect((await docs(c)).body.counts.all).toBe(0);
      expect((await c.get(`/api/doc-inbox/items/${mine.id}`)).status).toBe(404);
      expect((await docs(c, "all", "harbour")).body.items).toHaveLength(0);
      expect((await c.patch(`/api/doc-inbox/items/${mine.id}`, { paid: true })).status).toBe(404);
    }
    // Shared with Bob to view: he sees it, cannot change it.
    expect((await owner.put(`/api/drive/items/${mine.id}/shares`, { shares: [{ userId: bob.id, role: "view" }] })).status).toBe(200);
    const seen = await docs(bob.client);
    expect(seen.body.items).toHaveLength(1);
    expect(seen.body.items[0].canEdit).toBe(false);
    expect((await bob.client.get(`/api/doc-inbox/items/${mine.id}`)).body.text).toContain("Harbour");
    expect((await bob.client.patch(`/api/doc-inbox/items/${mine.id}`, { paid: true })).status).toBe(403);
    expect((await bob.client.post(`/api/doc-inbox/items/${mine.id}/read`)).status).toBe(403);
    // Revoked: gone again.
    expect((await owner.put(`/api/drive/items/${mine.id}/shares`, { shares: [] })).status).toBe(200);
    expect((await docs(bob.client)).body.items).toHaveLength(0);
    expect((await bob.client.get(`/api/doc-inbox/items/${mine.id}`)).status).toBe(404);
  });
  it("R98 search lists document text only to people who can open the file", async () => {
    const bob = await teammate("bob@acme.io");
    await upload(owner, "private-bill.txt", INVOICE, { space: "private" });
    await upload(owner, "team-bill.txt", PDF_TEXT);
    await docs(owner);
    const viewer = (c: { userId: string }) => ({ kind: "actor" as const, actor: { orgId, userId: c.userId, email: "", name: "", role: "member" as const } });
    const ownerId = (await owner.get("/api/account/me")).body.user.id as string;
    const o = await searchR98(ctx.deps, { kind: "actor", actor: { orgId, userId: ownerId, email: "owner@acme.io", name: "Olive", role: "owner" } }, "harbour supplies", { types: ["files"] });
    expect(o.groups.find((g) => g.type === "files")?.items.map((i) => i.title)).toContain("private-bill.txt");
    const b = await searchR98(ctx.deps, viewer({ userId: bob.id }), "harbour supplies", { types: ["files"] });
    expect(b.groups.find((g) => g.type === "files")?.items ?? []).toHaveLength(0);
    const b2 = await searchR98(ctx.deps, viewer({ userId: bob.id }), "bright sparks", { types: ["files"] });
    expect(b2.groups.find((g) => g.type === "files")?.items.map((i) => i.title)).toEqual(["team-bill.txt"]);
  });
  it("rules: owners and admins write, members read", async () => {
    const bob = await teammate("bob@acme.io");
    const ann = await teammate("ann@acme.io", "admin");
    const body = { name: "Phone bills", match: "any", pattern: "optus telstra", setTags: ["phone"], setType: "bill" };
    expect((await bob.client.post("/api/doc-inbox/rules", body)).status).toBe(403);
    const r = await ann.client.post("/api/doc-inbox/rules", body);
    expect(r.status).toBe(200);
    expect((await bob.client.get("/api/doc-inbox/rules")).body.rules.map((x: { name: string }) => x.name)).toEqual(["Phone bills"]);
    expect((await bob.client.put(`/api/doc-inbox/rules/${r.body.rule.id}`, body)).status).toBe(403);
    expect((await bob.client.call("DELETE", `/api/doc-inbox/rules/${r.body.rule.id}`)).status).toBe(403);
    expect((await owner.post("/api/doc-inbox/rules", { ...body, match: "regex", pattern: "(a+)+" })).status).toBe(422);
    expect((await owner.post("/api/doc-inbox/rules", { ...body, setTags: [], setType: null })).status).toBe(422);
  });
});

describe("R102 rules on documents", () => {
  beforeEach(() => setup());
  it("tags, type, sender and folder; first rule wins; private files never move into Team files", async () => {
    const folder = (await owner.post("/api/drive/folders", { space: "team", name: "Bills" })).body.item;
    const a = await owner.post("/api/doc-inbox/rules", { name: "Harbour", match: "fuzzy", pattern: "harbor supplies", setTags: ["supplier"], setSender: "Harbour Supplies", setFolderId: folder.id });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    await owner.post("/api/doc-inbox/rules", { name: "Later", match: "exact", pattern: "tax invoice", setTags: ["gst"], setSender: "Never used" });
    expect((await owner.post("/api/doc-inbox/rules", { name: "Bad folder", match: "any", pattern: "x", setFolderId: "nope" })).status).toBe(422);
    const team = await upload(owner, "h1.txt", INVOICE);
    const priv = await upload(owner, "h2.txt", INVOICE, { space: "private" });
    await docs(owner);
    const t = await owner.get(`/api/doc-inbox/items/${team.id}`);
    expect(t.body).toMatchObject({ tags: ["supplier", "gst"], fields: { sender: "Harbour Supplies" }, folder: { id: folder.id, name: "Bills" } });
    expect(t.body.rulesApplied.map((r: { name: string }) => r.name).sort()).toEqual(["Harbour", "Later"]);
    const p = await owner.get(`/api/doc-inbox/items/${priv.id}`);
    expect(p.body.folder.id).toBe(null);
    expect(p.body.tags).toEqual(["supplier", "gst"]);
    // Apply rules now keeps a corrected sender.
    await owner.patch(`/api/doc-inbox/items/${team.id}`, { sender: "HS" });
    const again = await owner.post(`/api/doc-inbox/items/${team.id}/apply-rules`);
    expect(again.body.fields.sender).toBe("HS");
  });
  it("reorders rules (admin) and ignores ids of other workspaces", async () => {
    const r1 = (await owner.post("/api/doc-inbox/rules", { name: "One", match: "any", pattern: "a", setTags: ["one"] })).body.rule;
    const r2 = (await owner.post("/api/doc-inbox/rules", { name: "Two", match: "any", pattern: "b", setTags: ["two"] })).body.rule;
    const o = await owner.post("/api/doc-inbox/rules/order", { ids: [r2.id, "drl_other", r1.id] });
    expect(o.body.rules.map((r: { name: string }) => r.name)).toEqual(["Two", "One"]);
  });
});

describe("R102 caps and exclusions", () => {
  it("over the daily cap a document waits and says so", async () => {
    await setup();
    await ctx.db.run(sql`insert into doc_inbox_state (org_id, day, n, updated_at) values (${orgId}, '2026-11-01', 60, 0)`);
    await upload(owner, "late.txt", INVOICE);
    const l = await docs(owner);
    expect(l.body.items[0]).toMatchObject({ status: "queued", capped: true });
    expect(l.body.counts.capped).toBe(true);
    const rep = await runDocPass(ctx.deps);
    expect(rep.capped).toBe(1);
    // The next day it is read.
    ctx.deps.now = () => new Date("2026-11-02T01:00:00Z");
    expect((await docs(owner)).body.items[0].status).toBe("done");
  });
  it("the global cap holds every workspace", async () => {
    await setup();
    await ctx.db.run(sql`insert into doc_inbox_state (org_id, day, n, updated_at) values ('*', '2026-11-01', 600, 0)`);
    await upload(owner, "late.txt", INVOICE);
    expect((await docs(owner)).body.items[0].status).toBe("queued");
  });
  it("the vv8k workspace is never read", async () => {
    await setup({}, "VV8K Client");
    expect(await excludedOrg(ctx.db, orgId)).toBe(true);
    await upload(owner, "client.txt", INVOICE);
    await runDocPass(ctx.deps);
    const l = await docs(owner);
    expect(l.body.items[0].status).toBe("skipped");
    expect((await owner.get(`/api/doc-inbox/items/${l.body.items[0].id}`)).body.text).toBe(null);
  });
  it("deleted files leave Documents at the next pass", async () => {
    await setup();
    const it0 = await upload(owner, "gone.txt", INVOICE);
    await docs(owner);
    await owner.post("/api/drive/trash", { ids: [it0.id] });
    expect((await docs(owner)).body.items).toHaveLength(0);
    await owner.post("/api/drive/delete", { ids: [it0.id] });
    await runDocPass(ctx.deps);
    const n = await ctx.db.all<{ n: number }>(sql`select count(*) as n from doc_inbox`);
    expect(Number(n[0].n)).toBe(0);
  });
  it("an older drive file can be added by someone who can change it", async () => {
    await setup({ DOC_INBOX_R102: "off" });
    const it0 = await upload(owner, "old.txt", INVOICE);
    ctx.deps.config.docInbox = true;
    const bob = await teammate("bob@acme.io");
    const add = await bob.client.post("/api/doc-inbox/add", { itemId: it0.id });
    expect(add.status).toBe(200);
    expect(add.body.status).toBe("done");
  });
});

describe("R102 mail attachments", () => {
  it("only the mailbox's own person (or an admin for a shared mailbox nobody owns) may add", async () => {
    await setup();
    const bob = await teammate("bob@acme.io");
    const ownerId = (await owner.get("/api/account/me")).body.user.id as string;
    const domain = "d_r102";
    await ctx.db.run(sql`insert into domains (id, org_id, name, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc, created_at) values (${domain}, ${orgId}, 'acme-r102.test', 'v', 's', 'p', 'e', 0)`);
    const box = async (id: string, address: string) => ctx.db.run(sql`insert into mailboxes (id, org_id, domain_id, local_part, address, display_name, quota_mb, created_at) values (${id}, ${orgId}, ${domain}, 'x', ${address}, 'X', 100, 0)`);
    await box("mb_bob", "bob@acme.io");
    await box("mb_shared", "accounts@acme-r102.test");
    const bobA = { orgId, userId: bob.id, email: "bob@acme.io", role: "member" as const };
    const own = { orgId, userId: ownerId, email: "owner@acme.io", role: "owner" as const };
    expect(await canAddFromMailbox(ctx.db, bobA, "mb_bob")).toBe(true);
    expect(await canAddFromMailbox(ctx.db, bobA, "mb_shared")).toBe(false);
    expect(await canAddFromMailbox(ctx.db, own, "mb_shared")).toBe(true);
    expect(await canAddFromMailbox(ctx.db, own, "mb_bob")).toBe(false);
    expect((await bob.client.post("/api/doc-inbox/from-mail", { attachmentId: "att_none" })).status).toBe(404);
    expect((await bob.client.get("/api/doc-inbox/mailboxes")).body.ids).toEqual(["mb_bob"]);
    expect((await owner.get("/api/doc-inbox/mailboxes")).body.ids).toEqual(["mb_shared"]);
  });
});
