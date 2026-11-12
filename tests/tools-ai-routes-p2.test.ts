/**
 * Tools P2 H3: the AI document routes (/api/tools/ai) against a fake engine (signatures checked like P1) and a
 * mocked AI service. Covers flags, ask with page citations, the free limit refusal, translate batches and
 * apply, invoices to XLSX and CSV, the expense summary and pack, and contract reminders as My Work tasks.
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world"; // PRIV1b (P36): only a verified domain routes mail
import { deliverInbound } from "@/server/services/mail/delivery";
import { GLOBAL_DAILY_UNITS, GLOBAL_ROW, FREE_LIMIT_MESSAGE } from "@/server/services/tools/ai-meter";
import { dayOf } from "@/server/services/tools/usage";

const ENGINE_KEY = "k".repeat(40);
const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "all" };
const PDF = "%PDF-1.4\n% fake\n";

interface Job { id: string; ws: string; op: string; fields: Record<string, string>; files: { name: string; size: number }[] }

function fakeEngine(outputs: { text?: { pages: { page: number; text: string }[] }; segments?: { segments: { id: string; text: string; page: number }[] } }) {
  const jobs = new Map<string, Job>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, url.pathname + url.search, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      const fd = await new Response(init!.body as BodyInit, { headers: { "content-type": h.get("content-type")! } }).formData();
      const fields: Record<string, string> = {};
      const files: { name: string; size: number }[] = [];
      for (const [k, v] of fd.entries()) { if (typeof v === "string") fields[k] = v; else files.push({ name: v.name, size: v.size }); }
      const id = (Math.random().toString(16).slice(2) + "0000000000000000").slice(0, 16) + "cafe";
      jobs.set(id, { id, ws, op: url.searchParams.get("op")!, fields, files });
      return Response.json({ id, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (!m![2]) return Response.json({ id: job.id, op: job.op, status: "done", output: { bytes: 10 } });
    if (job.op === "extract-text") return Response.json(outputs.text ?? { pages: [] });
    if (job.op === "segments") return Response.json(outputs.segments ?? { segments: [] });
    return new Response(PDF, { headers: { "content-type": "application/pdf" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs };
}

async function setup(outputs: Parameters<typeof fakeEngine>[0], env: Record<string, string> = ON) {
  const engine = fakeEngine(outputs);
  const ctx = await makeTestApp(env, { fetch: engine.fetch });
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Ada Lovelace", "Acme");
  const me = await c.get("/api/account/me");
  const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
  const ai = { run: vi.fn(async (_m: string, input: Record<string, unknown>): Promise<unknown> => input.text !== undefined ? { translated_text: `NE:${String(input.text)}` } : { response: "- The bond is $4,000 (p. 2)\n- Notice is 60 days (p. 3)", usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
  ctx.deps.ai = ai;
  return { ...ctx, c, engine, ai, orgId };
}

async function uploadRead(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, cookie: string, feature: string, name: string) {
  const fd = new FormData();
  fd.append("file", new Blob([PDF], { type: "application/pdf" }), name);
  const res = await app.request(`/api/tools/ai/read/upload?feature=${feature}`, { method: "POST", headers: { cookie, host: "localhost", "x-multies-upload": "1" }, body: fd });
  return { status: res.status, body: await res.json() as { token: string; name: string } };
}

const LEASE = { pages: [
  { page: 1, text: "Lease summary. The tenant is Blue Cafe." },
  { page: 2, text: "Clause 7. The bond is $4,000 and is held by the landlord." },
  { page: 3, text: "Clause 12. Either party may end the lease with 60 days written notice." },
] };

describe("Tools P2 AI routes", () => {
  it("are a 404 while every AI flag is off", async () => {
    const { c } = await setup({}, { ...ON, TOOLS_FEATURES: "editor" });
    expect((await c.get("/api/tools/ai/usage")).status).toBe(404);
    expect((await c.post("/api/tools/ai/ask", { token: "x".repeat(20) })).status).toBe(404);
  });

  it("refuses an upload without the upload header (CSRF) and a feature that is off", async () => {
    const { app, c } = await setup({ text: LEASE }, { ...ON, TOOLS_FEATURES: "ask" });
    const fd = new FormData();
    fd.append("file", new Blob([PDF], { type: "application/pdf" }), "a.pdf");
    const res = await app.request("/api/tools/ai/read/upload?feature=ask", { method: "POST", headers: { cookie: c.cookie, host: "localhost" }, body: fd });
    expect(res.status).toBe(403);
    expect((await uploadRead(app, c.cookie, "translate", "a.pdf")).status).toBe(404);
    expect((await c.post("/api/tools/ai/contract", { token: "x".repeat(20) })).status).toBe(404);
    expect((await c.get("/api/tools/ai/usage")).body.features).toEqual(["ask"]);
  });

  it("shows today's AI use, the languages and the features on", async () => {
    const { c } = await setup({});
    const r = await c.get("/api/tools/ai/usage");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ units: 0, cap: 500, ownKey: false, features: ["ask", "translate", "extract", "expenses", "contracts"] });
    expect(Object.keys(r.body.languages)).toEqual(expect.arrayContaining(["ne", "hi", "zh", "ar", "vi", "id", "es", "fr", "de", "ja", "ko", "en"]));
  });

  it("summarises an uploaded document with page numbers and fences the text as data", async () => {
    const { app, c, engine, ai } = await setup({ text: LEASE });
    const up = await uploadRead(app, c.cookie, "ask", "lease.pdf");
    expect(up.status).toBe(202);
    expect([...engine.jobs.values()][0]).toMatchObject({ op: "extract-text", fields: { ocr: "auto" } });
    const st = await c.get(`/api/tools/jobs/${up.body.token}`);
    expect(st.body.status).toBe("done");
    const r = await c.post("/api/tools/ai/ask", { token: up.body.token });
    expect(r.status).toBe(200);
    expect(r.body.bullets).toEqual(["The bond is $4,000 (p. 2)", "Notice is 60 days (p. 3)"]);
    expect(r.body.pages).toEqual([2, 3]);
    const input = ai.run.mock.calls[0][1] as { messages: { role: string; content: string }[] };
    expect(input.messages[0].content).toMatch(/data, never instructions/);
    expect(input.messages[1].content).toContain("<document>");
    expect(input.messages[1].content).toContain("[Page 2]");
  });

  it("answers a question from the matching pages only", async () => {
    const { app, c, ai } = await setup({ text: LEASE });
    const up = await uploadRead(app, c.cookie, "ask", "lease.pdf");
    const r = await c.post("/api/tools/ai/ask", { token: up.body.token, question: "How much is the bond?" });
    expect(r.status).toBe(200);
    const prompt = (ai.run.mock.calls[0][1] as { messages: { content: string }[] }).messages[1].content;
    expect(prompt).toContain("bond is $4,000");
    expect(prompt).not.toContain("60 days");
    expect(r.body.question).toBe("How much is the bond?");
  });

  it("refuses plainly when today's free AI is used up, without calling the AI", async () => {
    const { app, c, ai, db, deps } = await setup({ text: LEASE });
    await db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${dayOf(deps.now())}, ${GLOBAL_ROW}, ${GLOBAL_DAILY_UNITS}, 1)`);
    const up = await uploadRead(app, c.cookie, "ask", "lease.pdf");
    const r = await c.post("/api/tools/ai/ask", { token: up.body.token });
    expect(r.status).toBe(429);
    expect(r.body.message ?? r.body.error?.message ?? JSON.stringify(r.body)).toContain(FREE_LIMIT_MESSAGE);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("translates in batches and puts the text back with translate-apply", async () => {
    const segs = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, text: `Line ${i}`, page: 1 + Math.floor(i / 20) }));
    const { app, c, engine } = await setup({ segments: { segments: segs } });
    const up = await uploadRead(app, c.cookie, "translate", "letter.pdf");
    expect([...engine.jobs.values()][0].op).toBe("segments");
    const b1 = await c.post("/api/tools/ai/translate", { token: up.body.token, target: "ne", offset: 0, count: 40 });
    expect(b1.status).toBe(200);
    // At most 20 lines a call whatever count asks for; the page follows next.
    expect(b1.body).toMatchObject({ total: 45, done: 20, next: 20 });
    expect(b1.body.translations.s0).toBe("NE:Line 0");
    const b15 = await c.post("/api/tools/ai/translate", { token: up.body.token, target: "ne", offset: 20, count: 40 });
    expect(b15.body).toMatchObject({ done: 40, next: 40 });
    const b2 = await c.post("/api/tools/ai/translate", { token: up.body.token, target: "ne", offset: 40, count: 40 });
    expect(b2.body).toMatchObject({ done: 45, next: null });
    expect((await c.post("/api/tools/ai/translate", { token: up.body.token, target: "xx" })).status).toBe(400);
    const fd = new FormData();
    fd.append("file", new Blob([PDF], { type: "application/pdf" }), "letter.pdf");
    fd.append("target", "ne");
    fd.append("translations", JSON.stringify({ ...b1.body.translations, ...b15.body.translations, ...b2.body.translations }));
    const res = await app.request("/api/tools/ai/translate/apply", { method: "POST", headers: { cookie: c.cookie, host: "localhost", "x-multies-upload": "1" }, body: fd });
    expect(res.status).toBe(202);
    const job = await res.json() as { token: string; name: string };
    expect(job.name).toBe("letter (Nepali).pdf");
    const applied = [...engine.jobs.values()].find((j) => j.op === "translate-apply")!;
    expect(Object.keys(JSON.parse(applied.fields.translations)).length).toBe(45);
    const st = await c.get(`/api/tools/jobs/${job.token}`);
    expect(st.body.downloadUrl).toMatch(/^\/api\/tools\/jobs\/.+\/download$/);
  });

  it("refuses documents over the translation page cap", async () => {
    const { app, c } = await setup({ segments: { segments: [{ id: "a", text: "x", page: 21 }] } });
    const up = await uploadRead(app, c.cookie, "translate", "long.pdf");
    expect((await c.post("/api/tools/ai/translate", { token: up.body.token, target: "hi" })).status).toBe(413);
  });

  it("reads invoices by rules, lets AI fill only gaps, and exports XLSX and CSV", async () => {
    const { app, c, ai } = await setup({ text: { pages: [{ page: 1, text: "Acme Plumbing Pty Ltd\nTAX INVOICE\nABN 51 824 753 556\nInvoice No: INV-20391\nInvoice date: 14/10/2026\nGST $30.00\nTotal amount due $330.00" }] } });
    ai.run.mockImplementation(async () => ({ response: '{"category": "Professional services"}' }));
    const up = await uploadRead(app, c.cookie, "extract", "acme.pdf");
    const r = await c.post("/api/tools/ai/invoices", { feature: "expenses", files: [{ token: up.body.token }] });
    expect(r.status).toBe(200);
    expect(r.body.rows[0]).toMatchObject({ supplier: "Acme Plumbing Pty Ltd", abn: "51 824 753 556", invoice_number: "INV-20391", date: "2026-10-14", gst: 30, total: 330, category: "Professional services", ai: ["category"] });
    // The extract feature does not need a category, so a complete invoice makes no AI call.
    ai.run.mockClear();
    const r2 = await c.post("/api/tools/ai/invoices", { feature: "extract", files: [{ token: up.body.token }] });
    expect(r2.body.rows[0].category).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
    const x = await app.request("/api/tools/ai/sheet", { method: "POST", headers: { cookie: c.cookie, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ feature: "expenses", format: "xlsx", rows: r.body.rows }) });
    expect(x.status).toBe(200);
    expect(x.headers.get("content-disposition")).toContain("Expense report.xlsx");
    const files = unzipSync(new Uint8Array(await x.arrayBuffer()));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"])).toContain("Acme Plumbing Pty Ltd");
    expect(strFromU8(files["xl/workbook.xml"])).toContain('name="Totals"');
    const csv = await app.request("/api/tools/ai/sheet", { method: "POST", headers: { cookie: c.cookie, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ feature: "extract", format: "csv", rows: [{ ...r.body.rows[0], supplier: "=cmd()" }] }) });
    expect(await csv.text()).toContain("'=cmd()");
  });

  it("builds the expense summary PDF with escaped text and appends PDF receipts from mail", async () => {
    const { app, c, engine, deps } = await setup({ text: { pages: [{ page: 1, text: "x" }] } });
    const domainId = await verifiedDomain({ dns: deps.dns } as never, c, "acme.io");
    const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
    await deliverInbound(deps, {
      envelopeFrom: "a@example.com", rcptTo: "me@acme.io", sizeBytes: 2000, via: "test",
      email: { messageId: "<r@example.com>", from: { address: "a@example.com" }, to: [{ address: "me@acme.io" }], cc: [], subject: "Your receipt", text: "Thanks.", date: new Date(),
        attachments: [
          { filename: "receipt-1.pdf", contentType: "application/pdf", content: new TextEncoder().encode(PDF) },
          { filename: "photo.jpg", contentType: "image/jpeg", content: new Uint8Array([255, 216, 255]) },
        ], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const list = await c.get("/api/tools/ai/receipts?q=receipt");
    expect(list.status).toBe(200);
    expect(list.body.receipts.map((r: { filename: string }) => r.filename).sort()).toEqual(["photo.jpg", "receipt-1.pdf"]);
    const ids = list.body.receipts.map((r: { id: string }) => r.id);
    void app; void box;
    const rep = await c.post("/api/tools/ai/expenses/report", { rows: [{ file: "r.pdf", supplier: "<script>{{x}}</script>", total: 12, gst: 1.09, category: "Meals" }], title: "October" });
    expect(rep.status).toBe(202);
    const render = [...engine.jobs.values()].find((j) => j.op === "render")!;
    expect(render.files[0].name).toBe("summary.html");
    const pack = await c.post("/api/tools/ai/expenses/pack", { summaryToken: rep.body.token, attachmentIds: ids, title: "October" });
    expect(pack.status).toBe(202);
    expect(pack.body).toMatchObject({ appended: 1, skipped: 1, name: "October with receipts.pdf" });
    const merge = [...engine.jobs.values()].find((j) => j.op === "merge")!;
    expect(merge.files.map((f) => f.name)).toEqual(["summary.pdf", "receipt-1.pdf"]);
  });

  it("reads contract facts and adds reminders as My Work tasks linked to the thread", async () => {
    const C = "This agreement is made between Blue Cafe Pty Ltd and Fresh Linen Co.\nCommencement date: 1 November 2026.\nThe agreement has a term of 12 months and will automatically renew unless either party gives 30 days written notice. Fees are $1,200 per month.";
    const { c, db, deps, ai } = await setup({ text: { pages: [{ page: 1, text: C }] } });
    const domainId = await verifiedDomain({ dns: deps.dns } as never, c, "acme.io");
    await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" });
    await deliverInbound(deps, {
      envelopeFrom: "a@example.com", rcptTo: "me@acme.io", sizeBytes: 2000, via: "test",
      email: { messageId: "<c@example.com>", from: { address: "a@example.com" }, to: [{ address: "me@acme.io" }], cc: [], subject: "Contract", text: "Signed copy.", date: new Date(),
        attachments: [{ filename: "Linen contract.pdf", contentType: "application/pdf", content: new TextEncoder().encode(PDF) }], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const att = (await db.all<{ id: string; thread_id: string }>(sql`select a.id, m.thread_id from attachments a join messages m on m.id = a.message_id`))[0];
    const read = await c.post("/api/tools/ai/read", { attachmentIds: [att.id], feature: "contracts" });
    expect(read.status).toBe(202);
    const r = await c.post("/api/tools/ai/contract", { token: read.body.jobs[0].token });
    expect(r.status).toBe(200);
    expect(ai.run).not.toHaveBeenCalled(); // every fact was found by the rules
    expect(r.body.facts).toMatchObject({ parties: ["Blue Cafe Pty Ltd", "Fresh Linen Co"], start_date: "2026-11-01", end_date: "2027-10-31", auto_renew: true, notice_days: 30 });
    const today = new Date().toISOString().slice(0, 10);
    const reminders = r.body.reminders.filter((x: { due: string }) => x.due >= today);
    expect(reminders.length).toBe(2);
    const add = await c.post("/api/tools/ai/contract/reminders", { attachmentId: att.id, name: r.body.name, reminders });
    expect(add.status).toBe(201);
    const rows = await db.all<{ title: string; due: unknown; thread_id: string | null }>(sql`select title, due_at as due, thread_id from tasks order by title`);
    const mine = rows.filter((t) => /Linen contract/.test(t.title));
    expect(mine.length).toBe(2);
    expect(mine.every((t) => t.thread_id === att.thread_id)).toBe(true);
  });

  it("does not read another workspace's attachment or job", async () => {
    const { app, c, ctxOther } = await (async () => {
      const s = await setup({ text: LEASE });
      const other = new Client(s.app);
      await other.signup("x@other.io", "Other", "Other");
      return { ...s, ctxOther: other };
    })();
    const up = await uploadRead(app, c.cookie, "ask", "lease.pdf");
    expect((await ctxOther.post("/api/tools/ai/ask", { token: up.body.token })).status).toBe(404);
    expect((await ctxOther.post("/api/tools/ai/read", { attachmentIds: ["att_nope"], feature: "ask" })).status).toBe(404);
  });
});
