/**
 * Tools P2 (16, 17): the attachment index. A fake engine (signature checked like the real one) answers
 * extract-text with the uploaded file's own words, so the cron pass, the search group, the Files API and
 * the smart folder rules run end to end against SQLite with the real migrations: 0096 in the main database
 * (no text, no virtual table) and drizzle-index/0001 (FTS5) in the separate index database, as on Workers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { makeTestApp, Client } from "./helpers";
import { deliverInbound } from "@/server/services/mail/delivery";
import { mailboxAccess, members, sessions, users } from "@/server/db/schema";
import { resetWriteBudgetCache } from "@/server/services/write-budget";
import { INDEX_LIMITS, extractLocal, ftsMatch, indexStop, runIndexPass, forgetIndexCounts, searchAttachmentText } from "@/server/services/tools/attachment-index";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { INDEX_MIGRATIONS } from "@/server/db/index-migrations.generated";
import { classifyAttachment, validAbn } from "@/server/services/tools/attachment-classify";

const ENGINE_KEY = "k".repeat(40);
const ON = {
  TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40),
  TOOLS_FEATURES: "all",
};

interface Job { id: string; ws: string; text: string; lang: string; ocr: string; status: string }

/** Fake engine plus the Cloudflare analytics endpoint the D1 guard reads. */
function fakeWorld() {
  const jobs = new Map<string, Job>();
  const calls: { method: string; path: string; ws: string; user: string }[] = [];
  const reading = { rowsRead: 0, rowsWritten: 0 };
  let engineStatus = 202;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.cloudflare.com") {
      return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: reading.rowsWritten, rowsRead: reading.rowsRead }, dimensions: { databaseId: "db1", datetimeHour: "x" } }] }] } } });
    }
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const pathQs = url.pathname + url.search;
    let raw = new Uint8Array();
    if (init?.body) raw = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, pathQs, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    calls.push({ method, path: pathQs, ws, user: h.get("x-multies-user")! });
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      if (engineStatus !== 202) return Response.json({ error: "busy" }, { status: engineStatus });
      const fd = await new Request("http://x", { method: "POST", body: raw, headers: { "content-type": h.get("content-type")! } }).formData();
      const file = fd.get("files") as File;
      const id = `job${jobs.size + 1}abcdef`;
      jobs.set(id, { id, ws, text: await file.text(), lang: String(fd.get("language")), ocr: String(fd.get("ocr")), status: "done" });
      return Response.json({ id, op: url.searchParams.get("op"), status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-z0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "DELETE") { jobs.delete(job.id); return new Response(null, { status: 204 }); }
    if (m![2]) return Response.json({ pages: [{ page: 1, text: job.text.replace(/^%PDF\S*\s*/, ""), ocr: true }], chars: job.text.length });
    return Response.json({ id: job.id, status: job.status });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, calls, reading, setEngine: (s: number) => { engineStatus = s; } };
}

const INVOICE = "%PDF-1.4\nACME Pty Ltd\nTAX INVOICE\nABN 51 824 753 556\nInvoice number 1042\nTotal $1,320.00 including GST\nPayment terms 14 days";
const CONTRACT = "%PDF-1.4\nSERVICE AGREEMENT\nThis agreement is between the parties named below. Governing law New South Wales.\nSigned by ____________ Witness ____________";

async function world(extra: Record<string, string> = {}) {
  const w = fakeWorld();
  const ctx = await makeTestApp({ ...ON, ...extra }, { fetch: w.fetch });
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner", "Acme");
  const me = (await owner.get("/api/account/me")).body;
  const orgId: string = me.organization.id;
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const support = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox;
  const sales = (await owner.post("/api/mailboxes", { domainId, localPart: "sales", displayName: "Sales" })).body.mailbox;
  let n = 0;
  const deliver = async (to: string, subject: string, files: { name: string; type: string; body: string | Uint8Array }[], from = "billing@vendor.com") => {
    await deliverInbound(ctx.deps, {
      envelopeFrom: from, rcptTo: to, sizeBytes: 2000, via: "test",
      email: { messageId: `<m${++n}@vendor.com>`, from: { address: from, name: "Vendor Billing" }, to: [{ address: to }], cc: [], subject, text: "See attached.", date: new Date(Date.now() - (100 - n) * 60_000),
        attachments: files.map((f) => ({ filename: f.name, contentType: f.type, content: typeof f.body === "string" ? new TextEncoder().encode(f.body) : f.body })),
        authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
  };
  async function member(email: string, name: string, mailboxIds: string[]) {
    const c = new Client(ctx.app);
    await c.signup(email, name, "");
    const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
    await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
    await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
    for (const m of mailboxIds) await ctx.db.insert(mailboxAccess).values({ orgId, userId: u.id, mailboxId: m });
    return c;
  }
  return { ...ctx, w, owner, orgId, support, sales, deliver, member };
}

const raw = (db: unknown) => (db as { $client: { exec: (q: string) => void } }).$client;
type World = Awaited<ReturnType<typeof world>>;
const rows = (db: World["db"]) => db.all<{ id: number; attachment_id: string; filename: string; status: string; class: string | null; org_id: string; mailbox_id: string; chars: number }>(sql`select id, attachment_id, filename, status, class, org_id, mailbox_id, chars from attachment_text order by id`);
/** The text rows in the separate index database. */
const textRows = (t: World) => t.indexDb!.all<{ id: number; attachment_id: string; org_id: string; mailbox_id: string; text: string }>(sql`select rowid as id, attachment_id, org_id, mailbox_id, text from attachment_fts order by rowid`);
/** Counts the SQL statements prepared on a database from now on. */
function countStatements(db: unknown) {
  const client = (db as { $client: { prepare: (q: string) => unknown } }).$client;
  const prep = client.prepare.bind(client);
  const seen = { n: 0 };
  client.prepare = (q: string) => { seen.n++; return prep(q); };
  return seen;
}

beforeEach(() => { resetWriteBudgetCache(); forgetIndexCounts(); });

describe("Tools P2 smart folder rules", () => {
  it("checks ABNs with the modulus 89 rule", () => {
    expect(validAbn("51 824 753 556")).toBe(true);
    expect(validAbn("51 824 753 557")).toBe(false);
    expect(validAbn("1234")).toBe(false);
  });
  it("files invoices, receipts, quotes, contracts, statements, IDs, payslips and tax papers", () => {
    const c = (filename: string, text: string) => classifyAttachment({ filename, text });
    expect(c("doc.pdf", INVOICE)).toBe("invoice");
    expect(c("scan.pdf", "Receipt\nThank you for your purchase\nAmount paid $42.50\nCard ending 4242")).toBe("receipt");
    expect(c("q.pdf", "QUOTATION\nQuote number Q-77\nThis quote is valid until 30 November\nTotal $900.00")).toBe("quote");
    expect(c("x.pdf", CONTRACT)).toBe("contract");
    expect(c("x.pdf", "Bank statement\nStatement period 1 Sep to 30 Sep\nOpening balance $10.00\nClosing balance $20.00")).toBe("statement");
    expect(c("x.jpg", "AUSTRALIA PASSPORT\nPassport No PA1234567\nNationality AUSTRALIAN\nDate of expiry 2030")).toBe("id");
    expect(c("x.pdf", "Driver licence\nLicence number 12345678\nDate of birth 01/01/1990\nExpiry 2029 Class C")).toBe("id");
    expect(c("x.pdf", "Payslip\nGross pay $3,000.00\nNet pay $2,400.00\nSuperannuation $330.00")).toBe("payslip");
    expect(c("x.pdf", "Notice of assessment\nAustralian Taxation Office\nYear ended 30 June 2026")).toBe("tax");
    expect(c("holiday.jpg", "beach sunset with friends")).toBe("other");
    expect(c("invoice-1042.pdf", "")).toBe("other");
    expect(c("Invoice 1042.pdf", "Invoice\nTotal $20.00")).toBe("invoice");
  });
});

describe("Tools P2 attachment text on the Worker", () => {
  it("reads text, Word and Excel files itself", () => {
    expect(extractLocal("a.txt", new TextEncoder().encode("hello there"))).toBe("hello there");
    const docx = zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Tax</w:t></w:r><w:r><w:t xml:space="preserve"> invoice &amp; more</w:t></w:r></w:p></w:body></w:document>') });
    expect(extractLocal("a.docx", docx)).toContain("Tax invoice & more");
    const xlsx = zipSync({ "xl/sharedStrings.xml": strToU8("<sst><si><t>Supplier</t></si><si><t>Total</t></si></sst>") });
    expect(extractLocal("a.xlsx", xlsx)).toBe("Supplier\nTotal");
    expect(extractLocal("a.docx", new TextEncoder().encode("not a zip"))).toBeNull();
  });
  it("builds a MATCH that names the workspace, the mailbox scope and quoted words only", () => {
    expect(ftsMatch("org_1", null, ["tax", "inv"])).toBe('scope : "oorg1" AND text : ("tax" "inv"*)');
    expect(ftsMatch("org_1", ["mbx_a", "mbx_b"], ["x"])).toBe('scope : "oorg1" AND scope : ("mmbxa" OR "mmbxb") AND text : ("x")');
  });
});

describe("Tools P2 index pass", () => {
  it("indexes new attachments: PDFs through the engine (OCR auto, English), text files on the Worker, then search finds them", async () => {
    const t = await world();
    await t.deliver("support@acme.io", "Invoice 1042", [
      { name: "INV-1042.pdf", type: "application/pdf", body: INVOICE },
      { name: "notes.txt", type: "text/plain", body: "kangaroo meeting notes" },
      { name: "photo.gif", type: "image/gif", body: "GIF89a" },
    ]);
    // First pass: queue and submit (the text file is read at once); second pass: collect.
    const p1 = await runIndexPass(t.deps);
    expect(p1.stop).toBeNull();
    expect(p1).toMatchObject({ queued: 2, submitted: 1, local: 1 });
    const job = [...t.w.jobs.values()][0];
    expect(job).toMatchObject({ ws: t.orgId, ocr: "auto", lang: "eng" });
    expect(t.w.calls.find((c) => c.method === "POST")!.user).toBe("indexer");
    const p2 = await runIndexPass(t.deps);
    expect(p2.collected).toBe(1);
    const r = await rows(t.db);
    expect(r.map((x) => [x.filename, x.status, x.class]).sort()).toEqual([["INV-1042.pdf", "done", "invoice"], ["notes.txt", "done", "other"]]);
    // The text lives only in the index database, keyed by the main row's id, with the attachment, workspace and mailbox.
    const tr = await textRows(t);
    expect(tr.map((x) => [x.id, x.attachment_id, x.org_id, x.mailbox_id])).toEqual(r.map((x) => [x.id, x.attachment_id, x.org_id, x.mailbox_id]));
    expect(tr.find((x) => x.id === r.find((y) => y.filename === "notes.txt")!.id)!.text).toBe("kangaroo meeting notes");
    const cols = await t.db.all<{ name: string }>(sql`select name from pragma_table_info('attachment_text')`);
    expect(cols.map((c) => c.name)).not.toContain("body");
    // The finished job was deleted on the engine.
    expect(t.w.jobs.size).toBe(0);

    const s = await t.owner.get("/api/search?q=kangar");
    const g = s.body.groups.find((x: { type: string }) => x.type === "attachments");
    expect(g.label).toBe("Attachments");
    expect(g.items[0]).toMatchObject({ title: "notes.txt", subtitle: "Invoice 1042 · Vendor Billing" });
    expect(g.items[0].snippet).toContain("kangaroo");
    expect(g.items[0].url).toMatch(/^\/app\/mail\?mailbox=.+&m=.+&attachment=/);
    const s2 = await t.owner.get("/api/search?q=1,320");
    expect(s2.body.groups.find((x: { type: string }) => x.type === "attachments").items[0].title).toBe("INV-1042.pdf");
  });

  it("stops before the D1 read guard, on the write guard, with the feature off and with the workspace switch off", async () => {
    const t = await world({ CF_ANALYTICS_TOKEN: "x".repeat(20), CF_ACCOUNT_ID: "acc1", D1_DAILY_READ_BUDGET: "1000000" });
    await t.deliver("support@acme.io", "Doc", [{ name: "a.txt", type: "text/plain", body: "wombat" }]);
    t.w.reading.rowsRead = Math.ceil(1_000_000 * INDEX_LIMITS.readStopPct / 100); // 30% of reads used: stop
    expect(await indexStop(t.deps)).toBe("d1_reads");
    expect((await runIndexPass(t.deps)).stop).toBe("d1_reads");
    expect(await rows(t.db)).toHaveLength(0);
    expect(t.w.calls).toHaveLength(0);
    resetWriteBudgetCache();
    t.w.reading.rowsRead = 290_000; // 29%: runs
    expect(await indexStop(t.deps)).toBeNull();
    resetWriteBudgetCache();
    t.w.reading.rowsWritten = 30_000; // 30% of the 100,000 write budget
    expect(await indexStop(t.deps)).toBe("d1_writes");
    resetWriteBudgetCache();
    t.w.reading.rowsWritten = 0;
    expect((await runIndexPass(t.deps)).local).toBe(1);

    const off = await world({ TOOLS_FEATURES: "folders" });
    expect((await runIndexPass(off.deps)).stop).toBe("feature_off");
    const prod = await world({ APP_MODE: "production" });
    if (prod.deps.config.mode === "production") expect(await indexStop(prod.deps)).toBe("d1_unknown");

    const sw = await world();
    expect((await sw.owner.put("/api/tools/settings", { on: false })).status).toBe(200);
    await sw.deliver("support@acme.io", "Doc", [{ name: "a.txt", type: "text/plain", body: "wombat" }]);
    const p = await runIndexPass(sw.deps);
    expect(p.queued).toBe(0);
    expect(await rows(sw.db)).toHaveLength(0);
  });

  it("keeps each pass inside its budget: scan, engine jobs in flight, local reads and the daily caps", async () => {
    const t = await world();
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `doc${i}.pdf`, type: "application/pdf", body: `%PDF-1.4 page ${i}` }));
    const txts = Array.from({ length: 14 }, (_, i) => ({ name: `n${i}.txt`, type: "text/plain", body: `note ${i}` }));
    await t.deliver("support@acme.io", "Batch", [...files, ...txts]);
    const mainStatements = countStatements(t.db);
    const indexStatements = countStatements(t.indexDb);
    const p1 = await runIndexPass(t.deps);
    expect(p1.scanned).toBe(26);
    expect(p1.submitted).toBe(INDEX_LIMITS.submitPerPass);
    expect(p1.local).toBe(INDEX_LIMITS.localPerPass);
    // A bounded number of statements per pass in each database (no statement per scanned row; two per text written).
    expect(mainStatements.n).toBeLessThan(80);
    expect(indexStatements.n).toBeLessThanOrEqual(2 * INDEX_LIMITS.localPerPass);
    expect(await textRows(t)).toHaveLength(INDEX_LIMITS.localPerPass);
    const p2 = await runIndexPass(t.deps);
    expect(p2.collected).toBe(4);
    // Never more than inFlightMax engine jobs at once.
    expect(t.w.calls.filter((c) => c.method === "POST").length).toBeLessThanOrEqual(INDEX_LIMITS.submitPerPass * 2);
    const pending = await t.db.get<{ n: number }>(sql`select count(*) as n from attachment_text where status = 'pending'`);
    expect(Number(pending!.n)).toBeLessThanOrEqual(INDEX_LIMITS.inFlightMax);
    // The per workspace daily cap holds the rest until tomorrow.
    await t.db.run(sql`update attachment_index_state set n = ${INDEX_LIMITS.dailyPerWorkspace}, day = ${new Date().toISOString().slice(0, 10)} where org_id = ${t.orgId}`);
    const p3 = await runIndexPass(t.deps);
    expect(p3.local + p3.submitted).toBe(0);
    expect(p3.skippedCap).toBeGreaterThan(0);
  });

  it("backs off when the engine is busy and leaves the attachment queued", async () => {
    const t = await world();
    await t.deliver("support@acme.io", "Doc", [{ name: "a.pdf", type: "application/pdf", body: INVOICE }]);
    t.w.setEngine(503);
    const p = await runIndexPass(t.deps);
    expect(p.engineBusy).toBe(true);
    expect((await rows(t.db))[0].status).toBe("queued");
    t.w.setEngine(202);
    await runIndexPass(t.deps);
    await runIndexPass(t.deps);
    expect((await rows(t.db))[0].status).toBe("done");
  });
});

describe("Tools P2 attachment scope", () => {
  it("never shows a member attachment hits or folders from mailboxes outside their scope", async () => {
    const t = await world();
    await t.deliver("support@acme.io", "Support invoice", [{ name: "support-inv.txt", type: "text/plain", body: "TAX INVOICE ABN 51 824 753 556 Total $50.00 platypus" }]);
    await t.deliver("sales@acme.io", "Sales invoice", [{ name: "sales-inv.txt", type: "text/plain", body: "TAX INVOICE ABN 51 824 753 556 Total $70.00 platypus" }]);
    await runIndexPass(t.deps);
    const kiran = await t.member("kiran@acme.io", "Kiran Rao", [t.support.id]);
    const bea = await t.member("bea@acme.io", "Bea Bell", []);
    const titles = async (c: Client) => ((await c.get("/api/search?q=platypus")).body.groups.find((g: { type: string }) => g.type === "attachments")?.items ?? []).map((i: { title: string }) => i.title);
    expect((await titles(t.owner)).sort()).toEqual(["sales-inv.txt", "support-inv.txt"]);
    expect(await titles(kiran)).toEqual(["support-inv.txt"]);
    expect(await titles(bea)).toEqual([]);

    const f = await kiran.get("/api/attachment-files/folders");
    expect(f.status).toBe(200);
    expect(f.body.folders.find((x: { id: string }) => x.id === "invoice").count).toBe(1);
    expect((await t.owner.get("/api/attachment-files/folders")).body.folders.find((x: { id: string }) => x.id === "invoice").count).toBe(2);
    expect((await bea.get("/api/attachment-files/folders")).body.indexing.indexed).toBe(0);
    const list = await kiran.get("/api/attachment-files?folder=invoice");
    expect(list.body.items.map((i: { filename: string }) => i.filename)).toEqual(["support-inv.txt"]);
    expect(list.body.items[0]).toMatchObject({ subject: "Support invoice", from: "Vendor Billing <billing@vendor.com>" });
    expect((await kiran.get("/api/attachment-files?q=platypus")).body.items).toHaveLength(1);
    expect((await bea.get("/api/attachment-files?folder=invoice")).body.items).toEqual([]);

    // Moving: within scope it sticks (and the rules leave it); outside scope it is not found.
    const salesId = (await t.owner.get("/api/attachment-files?folder=invoice")).body.items.find((i: { filename: string }) => i.filename === "sales-inv.txt").attachmentId;
    expect((await kiran.put(`/api/attachment-files/${salesId}/folder`, { folder: "receipt" })).status).toBe(404);
    const supportId = list.body.items[0].attachmentId;
    expect((await kiran.put(`/api/attachment-files/${supportId}/folder`, { folder: "receipt" })).status).toBe(200);
    const moved = await kiran.get("/api/attachment-files?folder=receipt");
    expect(moved.body.items[0]).toMatchObject({ attachmentId: supportId, manual: true });
    expect((await kiran.put(`/api/attachment-files/${supportId}/folder`, { folder: "nope" })).status).toBe(422);

    // Another workspace never sees these.
    const other = new Client(t.app);
    await other.signup("x@other.io", "Xavier", "Other");
    expect(((await other.get("/api/search?q=platypus")).body.groups ?? []).find((g: { type: string }) => g.type === "attachments")).toBeUndefined();
    expect((await other.put(`/api/attachment-files/${supportId}/folder`, { folder: "other" })).status).toBe(404);
  });

  it("drops a deleted message's text with the sweep, and an admin turning indexing off deletes the index", async () => {
    const t = await world();
    await t.deliver("support@acme.io", "A", [{ name: "a.txt", type: "text/plain", body: "echidna one" }]);
    await t.deliver("support@acme.io", "B", [{ name: "b.txt", type: "text/plain", body: "echidna two" }]);
    await runIndexPass(t.deps);
    expect(await rows(t.db)).toHaveLength(2);
    // Delete message A outright: search hides it at once, the next pass deletes its text and index rows.
    await t.db.run(sql`delete from messages where subject = 'A'`);
    const hits = (await t.owner.get("/api/search?q=echidna")).body.groups.find((g: { type: string }) => g.type === "attachments").items;
    expect(hits.map((h: { title: string }) => h.title)).toEqual(["b.txt"]);
    expect((await runIndexPass(t.deps)).swept).toBe(1);
    expect((await rows(t.db)).map((r) => r.filename)).toEqual(["b.txt"]);
    expect((await textRows(t)).map((r) => r.text)).toEqual(["echidna two"]);
    raw(t.indexDb).exec("insert into attachment_fts(attachment_fts) values('integrity-check')");

    // Members cannot change the switch; admins can, and off deletes the index.
    const kiran = await t.member("kiran@acme.io", "Kiran Rao", [t.support.id]);
    expect((await kiran.put("/api/attachment-files/settings", { on: false })).status).toBe(403);
    expect((await t.owner.get("/api/attachment-files/settings")).body).toMatchObject({ on: true, lang: "eng" });
    expect((await t.owner.put("/api/attachment-files/settings", { on: false })).body).toMatchObject({ on: false });
    expect(await rows(t.db)).toHaveLength(0);
    expect(await textRows(t)).toHaveLength(0);
    raw(t.indexDb).exec("insert into attachment_fts(attachment_fts) values('integrity-check')");
    await t.deliver("support@acme.io", "C", [{ name: "c.txt", type: "text/plain", body: "echidna three" }]);
    expect((await runIndexPass(t.deps)).queued).toBe(0);
    // On again: the backfill walks back over older mail.
    expect((await t.owner.put("/api/attachment-files/settings", { on: true })).body).toMatchObject({ on: true });
    await runIndexPass(t.deps);
    expect((await rows(t.db)).map((r) => r.filename).sort()).toEqual(["b.txt", "c.txt"]);
    expect((await textRows(t)).map((r) => r.text).sort()).toEqual(["echidna three", "echidna two"]);
  });

  it("purges text the index database kept for a workspace that turned indexing off, even without a main row", async () => {
    const t = await world();
    await t.deliver("support@acme.io", "A", [{ name: "a.txt", type: "text/plain", body: "quokka" }]);
    await runIndexPass(t.deps);
    // A stray text row (a write that failed half way): its main row is gone.
    await t.indexDb!.run(sql`insert into attachment_fts (rowid, text, scope, attachment_id, org_id, mailbox_id) values (9999, 'quokka stray', ${`o${t.orgId.replace(/[^a-z0-9]/gi, "").toLowerCase()} mx`}, 'att_x', ${t.orgId}, 'mbx_x')`);
    expect(await textRows(t)).toHaveLength(2);
    expect((await t.owner.put("/api/attachment-files/settings", { on: false })).status).toBe(200);
    expect(await rows(t.db)).toHaveLength(0);
    expect(await textRows(t)).toHaveLength(0);
  });

  it("checks every index hit against its main row: workspace, mailbox scope (also past the token limit) and attachment id", async () => {
    const t = await world();
    await t.deliver("support@acme.io", "S", [{ name: "s.txt", type: "text/plain", body: "numbat support" }]);
    await t.deliver("sales@acme.io", "L", [{ name: "l.txt", type: "text/plain", body: "numbat sales" }]);
    await runIndexPass(t.deps);
    const long = [t.support.id, ...Array.from({ length: 45 }, (_, i) => `mbx_fake_${i}`)];
    const hits = await searchAttachmentText(t.deps, t.orgId, long, "numbat", { limit: 10 });
    expect(hits.map((h) => h.filename)).toEqual(["s.txt"]);
    expect(hits[0].snip).toContain("numbat");
    expect(await searchAttachmentText(t.deps, "org_other", null, "numbat", { limit: 10 })).toEqual([]);
    // A text row whose attachment id does not match the main row under its id is never shown.
    const s = (await rows(t.db)).find((r) => r.filename === "s.txt")!;
    await t.indexDb!.run(sql`update attachment_fts set attachment_id = 'att_wrong' where rowid = ${s.id}`);
    expect((await searchAttachmentText(t.deps, t.orgId, null, "numbat", { limit: 10 })).map((h) => h.filename)).toEqual(["l.txt"]);
  });

  it("keeps the main database free of virtual tables; the full text table is only in the index migrations", () => {
    const all = (list: { statements: string[] }[]) => list.flatMap((m) => m.statements).join("\n");
    expect(all(MIGRATIONS)).not.toMatch(/create\s+virtual\s+table/i);
    expect(all(INDEX_MIGRATIONS)).toMatch(/create virtual table `attachment_fts` using fts5\(text, scope, attachment_id unindexed, org_id unindexed, mailbox_id unindexed/i);
  });

  it("stays off quietly without an index database: no pass, no search, folders still answer", async () => {
    const w = fakeWorld();
    const ctx = await makeTestApp(ON, { fetch: w.fetch, noIndexDb: true });
    const owner = new Client(ctx.app);
    await owner.signup("owner@solo.io", "Sol Owner", "Solo");
    expect(await indexStop(ctx.deps)).toBe("no_index_db");
    expect((await runIndexPass(ctx.deps)).stop).toBe("no_index_db");
    expect((await owner.get("/api/tools")).body.features).not.toContain("index");
    expect((await owner.get("/api/tools")).body.features).toContain("folders");
    expect((await owner.get("/api/attachment-files/folders")).status).toBe(200);
    expect((await owner.get("/api/attachment-files?q=anything")).status).toBe(404);
    expect((await owner.get("/api/search?q=anything&types=attachments")).body.groups).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });

  it("answers 404 with the flags off", async () => {
    const t = await world({ TOOLS_FEATURES: "ask" });
    expect((await t.owner.get("/api/attachment-files/folders")).status).toBe(404);
    expect((await t.owner.get("/api/attachment-files/settings")).status).toBe(404);
    const s = await t.owner.get("/api/search?q=hello");
    expect(s.status).toBe(200);
    expect((await t.owner.get("/api/search?q=hello&types=attachments")).body.groups).toEqual([]);
  });
});
