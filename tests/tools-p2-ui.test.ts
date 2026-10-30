/**
 * Tools P2 (H2): the catalogue served by flag, P2 tool runs (uploads and attachments), result types that follow an
 * option, runToolJob for server code, and Tools results attached to a new email. The engine is a fake that checks
 * signatures like the real one; each job can say which output type it made.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { OCR_LANGUAGES, PII_KINDS, batchTools, catalogueFor, resultName, toolDef, toolsForFile, withExt, type ToolDef, type ToolsInfo } from "@/shared/tools";
import { deliverInbound } from "@/server/services/mail/delivery";
import { runToolJob, startToolJob } from "@/server/services/tools/run-job";
import { groupMatches, parseMatches, phrasesFor } from "@/web/components/tools/auto-redact";
import { planBatch, uniqueNames } from "@/web/components/tools/batch-tools";
import { tokenFromDownloadUrl, toolFileRefs } from "@/web/lib/tool-attach";

const ENGINE_KEY = "k".repeat(40);
const BASE = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40) };
const PDF = "%PDF-1.4\n% fake\n";

interface Job { id: string; ws: string; op: string; fields: Record<string, string>; files: { field: string; name: string }[]; ctype: string; body: string }

function fakeEngine() {
  const jobs = new Map<string, Job>();
  let nextType = "application/pdf";
  let nextBody = "result-bytes";
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, url.pathname + url.search, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST") {
      const fd = await new Request("http://x", { method: "POST", body: init!.body as BodyInit, headers: { "content-type": h.get("content-type")! }, duplex: "half" } as RequestInit).formData();
      const fields: Record<string, string> = {};
      const files: Job["files"] = [];
      for (const [k, v] of fd.entries()) { if (typeof v === "string") fields[k] = v; else files.push({ field: k, name: (v as File).name }); }
      const id = Math.random().toString(16).slice(2).padEnd(16, "b") + "cafe";
      jobs.set(id, { id, ws, op: url.searchParams.get("op")!, fields, files, ctype: nextType, body: nextBody });
      return Response.json({ id, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (m![2]) return new Response(job.body, { headers: { "content-type": job.ctype, "content-length": String(new TextEncoder().encode(job.body).byteLength) } });
    return Response.json({ id: job.id, status: "done", result: { matches: 2, tables: 3, secret: "x" }, output: { name: "out", bytes: job.body.length, content_type: job.ctype } });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, setOutput: (type: string, body = "result-bytes") => { nextType = type; nextBody = body; } };
}

async function setup(features = "all") {
  const engine = fakeEngine();
  const ctx = await makeTestApp({ ...BASE, TOOLS_FEATURES: features }, { fetch: engine.fetch });
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Ada Lovelace", "Acme");
  const me = (await c.get("/api/account/me")).body as { user: { id: string; email: string }; organization: { id: string } };
  return { ...ctx, c, engine, orgId: me.organization.id, userId: me.user.id };
}

async function upload(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, cookie: string, op: string, name: string, fields: Record<string, string> = {}, query = "") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("files", new Blob([PDF], { type: "application/pdf" }), name);
  const req = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const headers = { cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" };
  const res = await app.request(`/api/tools/jobs?op=${op}&files=1&name=${encodeURIComponent(name)}${query}`, { method: "POST", headers, body: bytes });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function withMail(features = "all") {
  const s = await setup(features);
  const domainId = (await s.c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const box = (await s.c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
  await deliverInbound(s.deps, {
    envelopeFrom: "a@example.com", rcptTo: "me@acme.io", sizeBytes: 2000, via: "test",
    email: { messageId: "<docs@example.com>", from: { address: "a@example.com" }, to: [{ address: "me@acme.io" }], cc: [], subject: "Docs", text: "Attached.", date: new Date(),
      attachments: [
        { filename: "Invoice 1.pdf", contentType: "application/pdf", content: new TextEncoder().encode(PDF) },
        { filename: "Invoice 2.pdf", contentType: "application/pdf", content: new TextEncoder().encode(PDF) },
        { filename: "rates.csv", contentType: "text/csv", content: new TextEncoder().encode("a,b\n1,2\n") },
      ], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
  const id = (await s.c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages[0].id;
  const atts = (await s.c.get(`/api/mail/messages/${id}`)).body.message.attachments as { id: string; filename: string }[];
  return { ...s, box, atts };
}

describe("Tools P2 catalogue by flag", () => {
  it("serves only P1 tools and English OCR when no P2 flag is on", async () => {
    const { c } = await setup("");
    const info = (await c.get("/api/tools")).body as ToolsInfo;
    expect(info.tools.length).toBe(13);
    expect(info.tools.every((t) => !t.feature)).toBe(true);
    expect(info.tools.find((t) => t.op === "ocr")!.options[0].choices).toEqual([{ value: "eng", label: "English" }]);
  });

  it("adds each P2 tool with its flag, and the wider OCR list only with ocr_langs", async () => {
    const { c } = await setup("protect,autoredact");
    const info = (await c.get("/api/tools")).body as ToolsInfo;
    expect(info.tools.map((t) => t.op)).toEqual(expect.arrayContaining(["protect", "pii-find"]));
    expect(info.tools.map((t) => t.op)).not.toContain("stamp");
    expect(info.tools.find((t) => t.op === "ocr")!.options[0].choices!.length).toBe(1);
    const all = (await (await setup("all")).c.get("/api/tools")).body as ToolsInfo;
    const langs = all.tools.find((t) => t.op === "ocr")!.options[0].choices!.map((x) => x.value);
    expect(langs).toEqual(expect.arrayContaining(["eng", "nep", "hin", "eng+nep", "eng+hin"]));
    expect(all.tools.find((t) => t.op === "scan-clean")!.options.find((o) => o.name === "language")!.choices!.length).toBe(OCR_LANGUAGES.length);
  });

  it("keeps catalogueFor pure: flags filter, OCR trims, nothing else changes", () => {
    const off = catalogueFor([]);
    expect(off.map((t) => t.op)).toEqual(catalogueFor(["nope"]).map((t) => t.op));
    expect(catalogueFor(["ocr_langs"]).find((t) => t.op === "ocr")!.options[0].choices!.length).toBe(OCR_LANGUAGES.length);
    expect(toolDef("ocr").options[0].choices!.length).toBe(OCR_LANGUAGES.length);
  });

  it("names results by the type an option picks, and follows the type the engine made", () => {
    expect(resultName("pdf-to", "Statement.pdf", { target: "xlsx" })).toBe("Statement.xlsx");
    expect(resultName("pdf-to", "Statement.pdf", { target: "png" })).toBe("Statement.zip");
    expect(resultName("pdf-to", "Statement.pdf")).toBe("Statement.txt");
    expect(resultName("excel-clean", "rates.csv")).toBe("rates-clean.xlsx");
    expect(withExt("a.txt", "csv")).toBe("a.csv");
    expect(withExt("a.txt", null)).toBe("a.txt");
  });

  it("lists P2 tools on an attachment only when their flag is on, and never flows with a second file slot", () => {
    expect(toolsForFile("rates.csv")).toEqual([]);
    expect(toolsForFile("rates.csv", ["excel", "convert_plus"]).map((t) => t.op)).toEqual(["to-pdf", "excel-clean"]);
    expect(toolsForFile("a.pdf", ["all", "autoredact"]).map((t) => t.op)).toContain("pii-find");
    const sign = { ...toolDef("protect"), op: "sign", feature: "esign", extra: { field: "x", label: "x", accept: ".png", min: 1, max: 1 } } as unknown as ToolDef;
    expect(batchTools(["esign", "protect"], [toolDef("protect"), sign]).map((t) => t.op)).toEqual(["protect"]);
    expect(batchTools(["autoredact", "batch"]).map((t) => t.op)).not.toContain("pii-find");
  });
});

describe("Tools P2 runs", () => {
  it("refuses a P2 tool whose flag is off (upload and attachment), and runs it when on", async () => {
    const off = await setup("stamps");
    expect((await upload(off.app, off.c.cookie, "protect", "a.pdf", { password: "hunter22" })).status).toBe(400);
    expect(off.engine.jobs.size).toBe(0);
    const on = await setup("protect");
    const r = await upload(on.app, on.c.cookie, "protect", "Lease.pdf", { password: "hunter22", allow_print: "yes", allow_copy: "no" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ op: "protect", name: "Lease-protected.pdf" });
    expect([...on.engine.jobs.values()][0].fields).toEqual({ password: "hunter22", allow_print: "yes", allow_copy: "no" });
  });

  it("pdf-to: the name and download type follow the target the engine made", async () => {
    const { app, c, engine } = await setup("convert_plus");
    engine.setOutput("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const r = await upload(app, c.cookie, "pdf-to", "Bank.pdf", { target: "xlsx" }, "&target=xlsx");
    expect(r.status).toBe(202);
    expect(r.body!.name).toBe("Bank.xlsx");
    const st = (await c.get(`/api/tools/jobs/${r.body!.token}`)).body as { name: string; downloadUrl: string; result: Record<string, unknown> };
    expect(st.name).toBe("Bank.xlsx");
    expect(st.result).toEqual({ matches: 2, tables: 3 });
    const dl = await app.request(st.downloadUrl, { headers: { cookie: c.cookie, host: "localhost" } });
    expect(dl.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(dl.headers.get("content-disposition")).toContain("Bank.xlsx");
  });

  it("a lying target hint only renames: the engine's real type wins at poll time", async () => {
    const { app, c, engine } = await setup("convert_plus");
    engine.setOutput("text/csv");
    const r = await upload(app, c.cookie, "pdf-to", "Bank.pdf", { target: "csv" }, "&target=xlsx");
    const st = (await c.get(`/api/tools/jobs/${r.body!.token}`)).body as { name: string };
    expect(st.name).toBe("Bank.csv");
  });

  it("auto redact: pii-find on an attachment takes the kinds as JSON, returns JSON, then redact burns the ticked phrases", async () => {
    const { app, c, engine, atts } = await withMail("autoredact");
    const pdf = atts.find((a) => a.filename === "Invoice 1.pdf")!;
    const found = JSON.stringify({ matches: [{ kind: "abn", text: "51 824 753 556", page: 1 }, { kind: "email", text: "jane@example.com", page: 2 }, { kind: "abn", text: "51 824 753 556", page: 1 }] });
    engine.setOutput("application/json", found);
    const r = await c.post("/api/tools/jobs/from-attachments", { op: "pii-find", attachmentIds: [pdf.id], options: { kinds: JSON.stringify(PII_KINDS.map((k) => k.kind)) } });
    expect(r.status).toBe(202);
    expect([...engine.jobs.values()][0].fields.kinds).toContain("bsb_account");
    const st = (await c.get(`/api/tools/jobs/${r.body.token}`)).body as { downloadUrl: string; name: string };
    expect(st.name).toBe("Invoice 1-found.json");
    const text = await (await app.request(st.downloadUrl, { headers: { cookie: c.cookie, host: "localhost" } })).text();
    const matches = parseMatches(text);
    const groups = groupMatches(matches);
    expect(groups.map((g) => [g.kind, g.items.length])).toEqual([["abn", 1], ["email", 1]]);
    const ticked = new Set([groups[0].items[0].key]);
    expect(phrasesFor(matches, ticked)).toBe("51 824 753 556");
    engine.setOutput("application/pdf");
    const burn = await c.post("/api/tools/jobs/from-attachments", { op: "redact", attachmentIds: [pdf.id], options: { phrases: phrasesFor(matches, ticked) } });
    expect(burn.status).toBe(202);
    expect([...engine.jobs.values()][1]).toMatchObject({ op: "redact", fields: { phrases: "51 824 753 556" } });
  });

  it("batch: one job per attachment, or one job for all with a multi file tool", async () => {
    const { c, engine, atts } = await withMail("batch,protect");
    const pdfs = atts.filter((a) => a.filename.endsWith(".pdf"));
    const plan = planBatch(toolDef("protect"), pdfs);
    expect(plan.map((p) => p.ids.length)).toEqual([1, 1]);
    for (const p of plan) expect((await c.post("/api/tools/jobs/from-attachments", { op: "protect", attachmentIds: p.ids, options: { password: "abcd" } })).status).toBe(202);
    const merge = planBatch(toolDef("merge"), pdfs);
    expect(merge).toHaveLength(1);
    expect((await c.post("/api/tools/jobs/from-attachments", { op: "merge", attachmentIds: merge[0].ids })).status).toBe(202);
    expect([...engine.jobs.values()].map((j) => [j.op, j.files.length])).toEqual([["protect", 1], ["protect", 1], ["merge", 2]]);
    expect(uniqueNames(["a.pdf", "A.pdf", "b.pdf", "a.pdf"])).toEqual(["a.pdf", "A (2).pdf", "b.pdf", "a (3).pdf"]);
  });
});

describe("runToolJob (server code)", () => {
  it("starts, waits and hands back the facts and the output bytes, counting one run", async () => {
    const { deps, engine, orgId, userId, db } = await setup("excel");
    engine.setOutput("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLSX!");
    const r = await runToolJob(deps, { orgId, userId }, "excel-clean", [{ name: "rates.csv", bytes: new TextEncoder().encode("a,b\n"), type: "text/csv" }], { dedupe: "yes" }, { sleep: async () => {}, source: "test" });
    expect(r.status).toBe("done");
    expect(r.result).toEqual({ matches: 2, tables: 3 });
    expect(new TextDecoder().decode(r.output!.bytes)).toBe("XLSX!");
    expect(r.output!.ext).toBe("xlsx");
    expect([...engine.jobs.values()][0]).toMatchObject({ op: "excel-clean", fields: { dedupe: "yes" } });
    const runs = await db.get<{ runs: number }>(sql`select sum(runs) as runs from tool_usage where org_id = ${orgId} and length(period) = 7`);
    expect(runs?.runs).toBe(1);
  });

  it("refuses a P2 op whose flag is off, sends extra files under their field, and can skip the usage count", async () => {
    const off = await setup("");
    await expect(runToolJob(off.deps, { orgId: off.orgId, userId: off.userId }, "protect", [{ name: "a.pdf", bytes: new Uint8Array([1]) }], { password: "abcd" })).rejects.toMatchObject({ status: 400 });
    const on = await setup("all");
    await startToolJob(on.deps, { orgId: on.orgId, userId: on.userId }, "extract-text", [{ name: "a.pdf", bytes: new Uint8Array([1]) }], { ocr: "auto" }, { count: false, extra: [] });
    const runs = await on.db.get<{ n: number }>(sql`select count(*) as n from tool_usage where org_id = ${on.orgId}`);
    expect(runs?.n).toBe(0);
    expect([...on.engine.jobs.values()][0]).toMatchObject({ op: "extract-text", fields: { ocr: "auto" } });
  });
});

describe("Attach Tools results to a new email", () => {
  it("sends the results as attachments, read from the engine at send time", async () => {
    const { app, c, engine, box, db } = await withMail("");
    await db.run(sql`update domains set status = 'verified' where name = 'acme.io'`);
    engine.setOutput("application/pdf", "%PDF-result");
    const r = await upload(app, c.cookie, "compress", "Big.pdf");
    const st = (await c.get(`/api/tools/jobs/${r.body!.token}`)).body as { downloadUrl: string; name: string; bytes: number };
    const refs = toolFileRefs([st]);
    expect(refs).toHaveLength(1);
    expect(tokenFromDownloadUrl(st.downloadUrl)).toBe(refs[0].token);
    const sent = await c.post("/api/mail/send", { mailboxId: box.id, to: ["me@acme.io"], subject: "Smaller", text: "Here", toolFiles: refs.map((f) => f.token) });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const rows = await db.all<{ filename: string; content_type: string }>(sql`select filename, content_type from attachments where filename = ${"Big-compressed.pdf"}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].content_type).toBe("application/pdf");
  });

  it("refuses a token from another workspace or a made up one (410), and sends nothing", async () => {
    const a = await withMail("");
    await a.db.run(sql`update domains set status = 'verified' where name = 'acme.io'`);
    const b = await setup("");
    const r = await upload(b.app, b.c.cookie, "compress", "Theirs.pdf");
    const st = (await b.c.get(`/api/tools/jobs/${r.body!.token}`)).body as { downloadUrl: string };
    const foreign = tokenFromDownloadUrl(st.downloadUrl)!;
    for (const tok of [foreign, "abc.def"]) {
      const sent = await a.c.post("/api/mail/send", { mailboxId: a.box.id, to: ["me@acme.io"], subject: "x", text: "x", toolFiles: [tok] });
      expect(sent.status).toBe(410);
    }
    const n = await a.db.get<{ n: number }>(sql`select count(*) as n from messages where folder = 'sent'`);
    expect(n?.n ?? 0).toBe(0);
  });
});
