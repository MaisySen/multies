/**
 * Tools P1, all 13 tools: the catalogue matches what the engine publishes, and every tool runs through
 * /api/tools against a fake engine (options reach it in the form, progress and result facts come back,
 * downloads carry the right type). The fake engine checks signatures like the real one.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { EXT_TYPES, TOOLS, isToolOp, resultName, toolDef, toolExtensions, toolsForFile, type ToolOp } from "@/shared/tools";
import { isEngineOnlyOp } from "@/server/services/tools/run-job";
import { deliverInbound } from "@/server/services/mail/delivery";

const ENGINE_KEY = "k".repeat(40);
const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40) };
const PDF = "%PDF-1.4\n% fake\n";

interface EngineOp {
  slug: string; accepts: string; min_files: number; max_files: number; output: { name: string; content_type: string };
  options: { name: string; kind: string; label: string; required: boolean; default?: string | number; choices?: string[]; min?: number; max?: number; max_len?: number }[];
  max_pages: number | null; max_bytes: number | null; slow: boolean;
  accepts_ext?: string[]; outputs?: { name: string; content_type: string }[];
}
const ENGINE = (JSON.parse(readFileSync("tests/fixtures/tools-engine-operations.json", "utf8")) as { operations: EngineOp[] }).operations;

interface Job { id: string; ws: string; op: string; status: string; fields: Record<string, string>; files: number; progress?: { done: number; total: number }; result?: Record<string, unknown> }

function fakeEngine() {
  const jobs = new Map<string, Job>();
  let next: Partial<Job> = {};
  let answer: Response | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, url.pathname + url.search, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST") {
      if (answer) { const a = answer; answer = null; return a; }
      const fd = await new Request("http://x", { method: "POST", body: init!.body as BodyInit, headers: { "content-type": h.get("content-type")! }, duplex: "half" } as RequestInit).formData();
      const fields: Record<string, string> = {};
      let files = 0;
      for (const [k, v] of fd.entries()) { if (typeof v === "string") fields[k] = v; else files += 1; }
      const id = Math.random().toString(16).slice(2).padEnd(16, "a") + "cafe";
      jobs.set(id, { id, ws, op: url.searchParams.get("op")!, status: "done", fields, files, ...next });
      next = {};
      return Response.json({ id, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    const op = ENGINE.find((o) => o.slug === job.op)!;
    if (m![2]) return new Response("result-bytes", { headers: { "content-type": op.output.content_type, "content-length": "12" } });
    return Response.json({ id: job.id, status: job.status, progress: job.progress, result: job.result, output: { name: op.output.name, bytes: 12, content_type: op.output.content_type } });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, setNext: (j: Partial<Job>) => { next = j; }, answerOnce: (r: Response) => { answer = r; } };
}

const TYPES: Record<string, string> = { pdf: "application/pdf", office: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", image: "image/png" };
const NAMES: Record<string, string> = { pdf: "Scan 7.pdf", office: "Report.docx", image: "photo.png" };

async function upload(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, cookie: string, op: string, files: number, fields: Record<string, string> = {}, kind = "pdf", queryFiles?: number, bodySize = 0) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (let i = 0; i < files; i++) fd.append("files", new Blob([bodySize ? "x".repeat(bodySize) : PDF], { type: TYPES[kind] }), i ? `${i}-${NAMES[kind]}` : NAMES[kind]);
  const req = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const headers = { cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" };
  const res = await app.request(`/api/tools/jobs?op=${op}&files=${queryFiles ?? files}&name=${encodeURIComponent(NAMES[kind])}`, { method: "POST", headers, body: bytes });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function setup() {
  const engine = fakeEngine();
  const ctx = await makeTestApp(ON, { fetch: engine.fetch });
  const c = new Client(ctx.app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const me = await c.get("/api/account/me");
  const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
  return { ...ctx, c, engine, orgId };
}

/** A valid set of options for each tool (the required ones filled in). */
const GOOD: Partial<Record<ToolOp, Record<string, string>>> = {
  split: { ranges: "1-2, 3" }, rotate: { angle: "270", ranges: "2" }, "to-jpeg": { dpi: "300" }, ocr: { language: "eng" },
  redact: { phrases: "Jane Citizen\n123 456 782" }, watermark: { text: "DRAFT", opacity: "40" }, unlock: { password: "hunter22" },
};

describe("Tools catalogue", () => {
  it("has the tools the engine publishes, with the same options, caps and result types", () => {
    // Tools P2: every card is an engine op; every engine op is a card or one that only server code runs.
    const slugs = ENGINE.map((o) => o.slug);
    for (const t of TOOLS) expect(slugs, t.op).toContain(t.op);
    for (const s of slugs) expect(isToolOp(s) || isEngineOnlyOp(s), s).toBe(true);
    for (const eo of ENGINE.filter((o) => isToolOp(o.slug))) {
      const t = toolDef(eo.slug as ToolOp);
      expect(t.minFiles, eo.slug).toBe(eo.min_files);
      if (t.maxFiles !== "plan") expect(t.maxFiles, eo.slug).toBe(eo.max_files);
      expect(t.contentType, eo.slug).toBe(eo.output.content_type);
      if (eo.accepts_ext) for (const x of eo.accepts_ext) expect(toolExtensions(t), `${eo.slug} takes ${x}`).toContain(x);
      if (t.extBy) expect(Object.values(t.extBy.exts).map((x) => EXT_TYPES[x]).sort(), eo.slug).toEqual([...new Set((eo.outputs ?? []).map((o) => o.content_type))].sort());
      expect(eo.output.name.endsWith(`.${t.ext}`), eo.slug).toBe(true);
      expect(t.maxPages ?? null, eo.slug).toBe(eo.max_pages);
      expect(t.maxBytes ?? null, eo.slug).toBe(eo.max_bytes);
      expect(!!t.slow, eo.slug).toBe(eo.slow);
      expect(t.options.map((o) => o.name), eo.slug).toEqual(eo.options.map((o) => o.name));
      for (const eopt of eo.options) {
        const o = t.options.find((x) => x.name === eopt.name)!;
        // Choice values are the contract; their order is how people see them (Multies lists English and Nepali first).
        expect({ kind: o.kind, required: !!o.required, default: o.default, choices: o.choices?.map((ch) => ch.value).sort(), min: o.min, max: o.max, maxLen: o.maxLen }, `${eo.slug}.${o.name}`)
          .toEqual({ kind: eopt.kind, required: eopt.required, default: eopt.default, choices: eopt.choices ? [...eopt.choices].sort() : eopt.choices, min: eopt.min, max: eopt.max, maxLen: eopt.max_len });
      }
    }
  });

  it("names results with the right extension", () => {
    expect(resultName("split", "Contract.pdf")).toBe("Contract-split.zip");
    expect(resultName("to-jpeg", "Deck.pdf")).toBe("Deck-pages.zip");
    expect(resultName("pdf-to-docx", "Letter.pdf")).toBe("Letter.docx");
    expect(resultName("redact", "HR file.pdf")).toBe("HR file-redacted.pdf");
  });

  it("says plainly that PDF to Word keeps text and basic layout only", () => {
    expect(toolDef("pdf-to-docx").note).toMatch(/^Text and basic layout only\./);
  });
});

describe("Tools P1 API, every tool", () => {
  it.each(TOOLS.filter((t) => !t.feature).map((t) => t.op))("runs %s: options reach the engine, the result downloads with its own type", async (op) => {
    const { c, app, engine } = await setup();
    const t = toolDef(op);
    const kind = t.accept.includes(".docx") ? "office" : t.accept.includes(".png") ? "image" : "pdf";
    const files = Math.max(t.minFiles, op === "images-to-pdf" ? 2 : 1);
    const up = await upload(app, c.cookie, op, files, GOOD[op] ?? {}, kind);
    expect(up.status, JSON.stringify(up.body)).toBe(202);
    expect(up.body!.name).toBe(resultName(op, NAMES[kind]));
    const job = [...engine.jobs.values()][0];
    expect(job.op).toBe(op);
    expect(job.files).toBe(files);
    // Form encoding sends line breaks as CRLF; the engine splits phrases on either.
    expect(Object.fromEntries(Object.entries(job.fields).map(([k, v]) => [k, v.replace(/\r\n/g, "\n")]))).toEqual(GOOD[op] ?? {});
    const st = await c.get(`/api/tools/jobs/${up.body!.token}`);
    expect(st.body).toMatchObject({ op, status: "done" });
    const dl = await app.request((st.body as { downloadUrl: string }).downloadUrl, { headers: { cookie: c.cookie, host: "localhost" } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe(t.contentType);
    expect(dl.headers.get("content-disposition")).toContain(encodeURIComponent(resultName(op, NAMES[kind])));
  });

  it("passes page progress while a slow tool runs, and only the known result facts when done", async () => {
    const { c, app, engine } = await setup();
    engine.setNext({ status: "running", progress: { done: 4, total: 18 } });
    const up = await upload(app, c.cookie, "ocr", 1, { language: "eng" });
    const run = await c.get(`/api/tools/jobs/${up.body!.token}`);
    expect(run.body).toMatchObject({ status: "running", progress: { done: 4, total: 18 } });
    engine.setNext({ status: "done", result: { matches: 7, phrases: 2, verified: true, pages_changed: 1, secret: "nope" } });
    const up2 = await upload(app, c.cookie, "redact", 1, { phrases: "Jane" });
    const done = await c.get(`/api/tools/jobs/${up2.body!.token}`);
    expect((done.body as { result: unknown }).result).toEqual({ matches: 7, phrases: 2, verified: true, pages_changed: 1 });
  });

  it("caps OCR at 20 MB before calling the engine, and images at 50 files", async () => {
    const { c, app, db, engine, orgId } = await setup();
    await db.run(sql`update organizations set plan = 'pro' where id = ${orgId}`);
    const ocr = await upload(app, c.cookie, "ocr", 1, { language: "eng" }, "pdf", undefined, 20 * 1024 * 1024 + 70 * 1024);
    expect(ocr.status).toBe(413);
    expect(JSON.stringify(ocr.body)).toContain("20 MB");
    const many = await upload(app, c.cookie, "images-to-pdf", 1, {}, "image", 51);
    expect(many.status).toBe(400);
    expect(engine.jobs.size).toBe(0);
  });

  it("hands on the engine's busy answer (429) and its plain message for a bad option (422)", async () => {
    const { c, app, engine } = await setup();
    engine.answerOnce(Response.json({ error: "busy", message: "The tools are busy. Try again in a minute." }, { status: 429 }));
    const busy = await upload(app, c.cookie, "ocr", 1);
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: { code: "tools_busy" } });
    engine.answerOnce(Response.json({ error: "bad_file", message: "Pages: use page numbers and ranges like 1-3, 5." }, { status: 400 }));
    const bad = await upload(app, c.cookie, "split", 1, { ranges: "x" });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("1-3, 5");
  });
});


describe("Tools P1 from mail attachments", () => {
  async function withMail() {
    const engine = fakeEngine();
    const ctx = await makeTestApp(ON, { fetch: engine.fetch });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Ada Lovelace", "Acme");
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
    await deliverInbound(ctx.deps, {
      envelopeFrom: "a@example.com", rcptTo: "me@acme.io", sizeBytes: 2000, via: "test",
      email: { messageId: "<docs@example.com>", from: { address: "a@example.com" }, to: [{ address: "me@acme.io" }], cc: [], subject: "Docs", text: "Attached.", date: new Date(),
        attachments: [
          { filename: "Q3 report.pdf", contentType: "application/pdf", content: new TextEncoder().encode(PDF) },
          { filename: "notes.txt", contentType: "text/plain", content: new TextEncoder().encode("hello") },
        ], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
    });
    const id = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages[0].id;
    const atts = (await c.get(`/api/mail/messages/${id}`)).body.message.attachments as { id: string; filename: string }[];
    const pdf = atts.find((a) => a.filename.endsWith(".pdf"))!;
    const txt = atts.find((a) => a.filename.endsWith(".txt"))!;
    return { ...ctx, c, engine, pdf, txt };
  }

  it("offers the tools that take a file, by its type", () => {
    expect(toolsForFile("Q3 report.pdf").map((t) => t.op)).toContain("redact");
    expect(toolsForFile("Q3 report.pdf").map((t) => t.op)).not.toContain("merge");
    expect(toolsForFile("deck.PPTX").map((t) => t.op)).toEqual(["convert"]);
    expect(toolsForFile("photo.jpg").map((t) => t.op)).toEqual(["images-to-pdf"]);
    expect(toolsForFile("notes.txt")).toEqual([]);
  });

  it("runs a tool on an attachment without an upload, with its options, and audits the source", async () => {
    const { c, db, engine, pdf } = await withMail();
    const r = await c.post("/api/tools/jobs/from-attachments", { op: "watermark", attachmentIds: [pdf.id], options: { text: "DRAFT", opacity: "30", stray: "x" } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ op: "watermark", name: "Q3 report-watermarked.pdf" });
    const job = [...engine.jobs.values()][0];
    expect(job).toMatchObject({ op: "watermark", files: 1, fields: { text: "DRAFT", opacity: "30" } });
    const rows = await db.all<{ metadata: string }>(sql`select metadata from audit_logs where action = 'tools.run'`);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ op: "watermark", source: "attachment", files: 1 });
    expect(rows[0].metadata).not.toContain("Q3");
    const st = await c.get(`/api/tools/jobs/${(r.body as { token: string }).token}`);
    expect(st.body).toMatchObject({ status: "done" });
  });

  it("refuses a file the tool does not take (422), an unknown attachment (404) and a bad body (400)", async () => {
    const { c, engine, txt } = await withMail();
    expect((await c.post("/api/tools/jobs/from-attachments", { op: "compress", attachmentIds: [txt.id] })).status).toBe(422);
    expect((await c.post("/api/tools/jobs/from-attachments", { op: "compress", attachmentIds: ["att_nope"] })).status).toBe(404);
    expect((await c.post("/api/tools/jobs/from-attachments", { op: "replace", attachmentIds: [txt.id] })).status).toBe(400);
    expect(engine.jobs.size).toBe(0);
  });

  it("does not reach another workspace's attachment", async () => {
    const { app, pdf } = await withMail();
    const other = new Client(app);
    await other.signup(undefined, "Eve", "Other Co");
    expect((await other.post("/api/tools/jobs/from-attachments", { op: "compress", attachmentIds: [pdf.id] })).status).toBe(404);
  });
});
