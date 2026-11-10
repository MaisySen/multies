/**
 * Tools P2, H7: the editors' API (/api/tools/editors) against a fake engine that checks signatures like
 * the real one: page editor (thumbnails, organize), form filler (form-fields, form-fill) and compare.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world"; // PRIV1b (P36): only a verified domain routes mail
import { deliverInbound } from "@/server/services/mail/delivery";
import {
  TOOLS_EDITORS, changedValues, editorResultName, fieldLabel, initialValues, missingRequired, planProblem, planSummary,
  readCompareChanges, readFormFields, turn, valuesToSend,
} from "@/shared/tools-editors";
import { TOOL_FEATURES } from "@/shared/tool-features";

const ENGINE_KEY = "k".repeat(40);
const ON = { TOOLS_ENABLED: "true", TOOLS_FEATURES: "editor,forms,compare", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40) };
const PDF = "%PDF-1.4\n% fake\n";

interface Job { id: string; ws: string; op: string; status: string; fields: Record<string, string>; files: string[]; result?: Record<string, unknown> }

function fakeEngine() {
  const jobs = new Map<string, Job>();
  let refuse: { status: number; message: string } | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const pathQs = url.pathname + url.search;
    let raw = new Uint8Array();
    if (init?.body) raw = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, pathQs, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (init?.body && String(raw.byteLength) !== len) return Response.json({ error: "length mismatch" }, { status: 400 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      if (refuse) return Response.json({ error: "bad_input", message: refuse.message }, { status: refuse.status });
      const form = await new Request("http://x/", { method: "POST", body: raw, headers: { "content-type": h.get("content-type")! } }).formData();
      const fields: Record<string, string> = {};
      const files: string[] = [];
      for (const [k, v] of form.entries()) { if (typeof v === "string") fields[k] = v; else files.push(v.name); }
      const op = url.searchParams.get("op")!;
      const id = (Math.random().toString(16).slice(2) + "0000000000000000").slice(0, 16) + "beef";
      const result: Record<string, unknown> = op === "compare" ? { pages_changed: 2, words_added: 5, words_removed: 3, secret: "x" } : op === "thumbnails" ? { pages: 3 } : op === "form-fields" ? { fields: 2 } : op === "form-fill" ? { fields_filled: 1 } : { pages: 2 };
      jobs.set(id, { id, ws, op, status: "done", fields, files, result });
      return Response.json({ id, op, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (m![2]) {
      const body = job.op === "form-fields" ? JSON.stringify({ fields: [{ name: "Name", type: "text", value: "", options: [], page: 1, rect: [0, 0, 1, 1], required: true }] })
        : job.op === "compare" && job.fields.output === "json" ? JSON.stringify({ pages: [{ page: 2, added: ["new words"], removed: ["old"] }] })
        : job.op === "thumbnails" ? "PK\x03\x04zip" : PDF;
      return new Response(body, { headers: { "content-length": String(body.length) } });
    }
    return Response.json({ id: job.id, op: job.op, status: job.status, output: { bytes: 100 }, result: job.result });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, refuse: (r: { status: number; message: string } | null) => { refuse = r; } };
}

async function upload(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, cookie: string, path: string, files: string[], fields: Record<string, string> = {}, noHeader = false) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append("files", new Blob([PDF], { type: "application/pdf" }), f);
  const req = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const headers: Record<string, string> = { cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength) };
  if (!noHeader) headers["x-multies-upload"] = "1";
  const res = await app.request(path, { method: "POST", headers, body: bytes });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

async function setup(env: Record<string, string> = ON) {
  const engine = fakeEngine();
  const ctx = await makeTestApp(env, { fetch: engine.fetch });
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Ada Lovelace", "Acme");
  const cookie = (c as unknown as { cookie: string }).cookie;
  return { ...ctx, c, engine, cookie };
}

const runs = async (db: Awaited<ReturnType<typeof makeTestApp>>["db"]) => Number((await db.get<{ n: number | null }>(sql`select sum(runs) as n from tool_usage where length(period) = 10`))?.n ?? 0);

describe("Tools P2 editors: catalogue entries", () => {
  it("carry their feature flag, page and phone rule", () => {
    expect(TOOLS_EDITORS.map((t) => [t.op, t.feature, !!t.webOnly])).toEqual([["organize", "editor", true], ["form-fill", "forms", false], ["compare", "compare", true]]);
    for (const t of TOOLS_EDITORS) {
      expect(TOOL_FEATURES).toContain(t.feature);
      expect(t.path).toMatch(/^\/app\/tools\/[a-z]+$/);
      expect(`${t.label} ${t.blurb} ${t.note ?? ""}`).not.toMatch(/[\u2013\u2014]/);
    }
    expect(editorResultName("organize", "Q3 report.pdf")).toBe("Q3 report-edited.pdf");
    expect(editorResultName("compare", "v2.pdf", "json")).toBe("v2-changes.json");
  });
});

describe("Tools P2 editors: page plan, form and change list helpers", () => {
  it("checks a page plan", () => {
    expect(planProblem([{ page: 2, rotate: 90 }, { page: 1, rotate: 0 }], 2)).toBeNull();
    expect(planProblem([], 2)).toMatch(/at least one/);
    expect(planProblem([{ page: 3, rotate: 0 }], 2)).toMatch(/does not have/);
    expect(planProblem([{ page: 1, rotate: 45 }], 2)).toMatch(/quarter/);
    expect(planProblem([{ page: 1, rotate: 0, x: 1 }], 2)).toMatch(/not valid/);
    expect(planProblem("nope")).toMatch(/at least one/);
    expect(turn(0, -90)).toBe(270);
    expect(turn(270, 90)).toBe(0);
  });
  it("summarises the plan", () => {
    expect(planSummary([{ page: 1, rotate: 0 }, { page: 2, rotate: 0 }], 2)).toBe("No changes yet");
    expect(planSummary([{ page: 2, rotate: 0 }, { page: 1, rotate: 90 }], 3)).toBe("2 pages: new order, 1 turned, 1 deleted");
    expect(planSummary([{ page: 1, rotate: 0 }, { page: 3, rotate: 0 }], 3)).toBe("2 pages: 1 deleted");
  });
  it("reads form fields defensively and builds answers", () => {
    const fields = readFormFields({ fields: [
      { name: "Applicant.First_name[0]", type: "text", value: "Jo", required: true },
      { name: "agree", type: "checkbox", value: "Off" },
      { name: "colour", type: "choice", value: "Red", options: ["Red", "Blue", 3] },
      { name: "sig", type: "signature" },
      { name: "agree", type: "text" }, { name: "", type: "text" }, { name: "x", type: "weird" }, null,
    ] });
    expect(fields.map((f) => f.name)).toEqual(["Applicant.First_name[0]", "agree", "colour", "sig"]);
    expect(fields[2].options).toEqual(["Red", "Blue"]);
    expect(fieldLabel(fields[0].name)).toBe("First name");
    expect(fieldLabel("homePhone")).toBe("Home phone");
    const v = initialValues(fields);
    expect(v).toEqual({ "Applicant.First_name[0]": "Jo", agree: false, colour: "Red" });
    expect(missingRequired(fields, { ...v, "Applicant.First_name[0]": " " })).toEqual(["Applicant.First_name[0]"]);
    expect(changedValues(fields, { ...v, agree: true, colour: "Green" })).toEqual({ agree: true });
    expect(changedValues(fields, { ...v, colour: "Blue" })).toEqual({ colour: "Blue" });
    expect(readFormFields("x")).toEqual([]);
    // The engine's shapes: a checkbox's on state in options, a radio group at "Off".
    const eng = readFormFields({ fields: [
      { name: "ok", type: "checkbox", value: "On1", options: ["On1"] },
      { name: "plan", type: "radio", value: "Off", options: ["Monthly", "Yearly"], required: true },
    ] });
    expect(initialValues(eng)).toEqual({ ok: true, plan: "" });
    expect(missingRequired(eng, initialValues(eng))).toEqual(["plan"]);
    expect(valuesToSend(eng, initialValues(eng), false)).toEqual({});
    expect(valuesToSend(eng, initialValues(eng), true)).toEqual({ ok: true });
    expect(valuesToSend(eng, { ...initialValues(eng), plan: "Yearly" }, true)).toEqual({ plan: "Yearly" });
  });
  it("reads the change list defensively", () => {
    const ch = readCompareChanges({ pages: [{ page: 3, added: ["two words"], removed: [] }, { page: 1, added: [], removed: ["gone", 4, " "] }, { page: 2, added: [], removed: [] }, { page: -1, added: ["x"] }] });
    expect(ch.pages.map((p) => p.page)).toEqual([1, 3]);
    expect(ch.pages[0].removed).toEqual(["gone"]);
    expect(ch.wordsAdded).toBe(2);
    expect(ch.wordsRemoved).toBe(1);
    expect(readCompareChanges(null).pages).toEqual([]);
  });
});

describe("Tools P2 editors: API", () => {
  it("answers 404 while the feature flag is off, per feature", async () => {
    const { app, cookie, c, engine } = await setup({ ...ON, TOOLS_FEATURES: "forms" });
    expect((await upload(app, cookie, "/api/tools/editors/jobs?op=thumbnails&name=a.pdf", ["a.pdf"])).status).toBe(404);
    expect((await upload(app, cookie, "/api/tools/editors/compare", ["a.pdf", "b.pdf"])).status).toBe(404);
    expect((await upload(app, cookie, "/api/tools/editors/jobs?op=form-fields&name=a.pdf", ["a.pdf"])).status).toBe(202);
    expect((await c.post("/api/tools/editors/jobs/from-attachments", { op: "organize", attachmentIds: ["x"], options: { plan: "[]" } })).status).toBe(404);
    expect(engine.jobs.size).toBe(1);
  });

  it("is off with Tools off, and refuses an upload without the page's header", async () => {
    const off = await setup({ ...ON, TOOLS_ENABLED: "false" });
    expect((await upload(off.app, off.cookie, "/api/tools/editors/jobs?op=thumbnails", ["a.pdf"])).status).toBe(404);
    const { app, cookie, engine } = await setup();
    expect((await upload(app, cookie, "/api/tools/editors/jobs?op=thumbnails", ["a.pdf"], {}, true)).status).toBe(403);
    expect((await upload(app, cookie, "/api/tools/editors/jobs?op=compress", ["a.pdf"])).status).toBe(400);
    expect(engine.jobs.size).toBe(0);
  });

  it("page editor: thumbnails are a free preview, organize saves the plan as one run", async () => {
    const { app, cookie, c, engine, db } = await setup();
    const t = await upload(app, cookie, "/api/tools/editors/jobs?op=thumbnails&name=Deck.pdf", ["Deck.pdf"]);
    expect(t.body).toMatchObject({ op: "thumbnails", name: "Deck-pages.zip" });
    expect(t.status).toBe(202);
    expect(await runs(db)).toBe(0);
    const st = await c.get(`/api/tools/editors/jobs/${t.body!.token}`);
    expect(st.body).toMatchObject({ status: "done", result: { pages: 3 } });
    const dl = await app.request(st.body.downloadUrl, { headers: { cookie, host: "localhost" } });
    expect(dl.headers.get("content-type")).toBe("application/zip");
    const plan = JSON.stringify([{ page: 3, rotate: 90 }, { page: 1, rotate: 0 }]);
    const o = await upload(app, cookie, "/api/tools/editors/jobs?op=organize&name=Deck.pdf", ["Deck.pdf"], { plan });
    expect(o.status).toBe(202);
    expect(o.body).toMatchObject({ op: "organize", name: "Deck-edited.pdf" });
    const job = [...engine.jobs.values()].find((j) => j.op === "organize")!;
    expect(job.fields.plan).toBe(plan);
    // R66 (MB-256): counted when the status read sees it finished, once.
    expect(await runs(db)).toBe(0);
    expect((await c.get(`/api/tools/editors/jobs/${o.body!.token}`)).body).toMatchObject({ status: "done" });
    expect(await runs(db)).toBe(1);
    await c.get(`/api/tools/editors/jobs/${o.body!.token}`);
    expect(await runs(db)).toBe(1);
    const audit = await db.all<{ metadata: string }>(sql`select metadata from audit_logs where action = 'tools.run'`);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).not.toContain("Deck");
  });

  it("passes the engine's plain refusal through as 422", async () => {
    const { app, cookie, engine } = await setup();
    engine.refuse({ status: 400, message: "This PDF has no form fields." });
    const r = await upload(app, cookie, "/api/tools/editors/jobs?op=form-fields&name=a.pdf", ["a.pdf"]);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("no form fields");
  });

  it("compare: one upload, two engine jobs (report and change list), one run, facts filtered", async () => {
    const { app, cookie, c, engine, db } = await setup();
    const r = await upload(app, cookie, "/api/tools/editors/compare", ["v1.pdf", "v2.pdf"]);
    expect(r.status).toBe(202);
    const body = r.body as { report: { token: string; name: string }; changes: { token: string; name: string } };
    expect(body.report.name).toBe("v2-changes.pdf");
    expect(body.changes.name).toBe("v2-changes.json");
    const jobs = [...engine.jobs.values()];
    expect(jobs.map((j) => j.fields.output).sort()).toEqual(["json", "pdf"]);
    for (const j of jobs) expect(j.files).toEqual(["v1.pdf", "v2.pdf"]);
    expect(await runs(db)).toBe(0);
    const st = await c.get(`/api/tools/editors/jobs/${body.report.token}`);
    expect(await runs(db)).toBe(1);
    expect(st.body.result).toEqual({ pages_changed: 2, words_added: 5, words_removed: 3 });
    const ch = await c.get(`/api/tools/editors/jobs/${body.changes.token}`);
    const dl = await app.request(ch.body.downloadUrl, { headers: { cookie, host: "localhost" } });
    expect(dl.headers.get("content-type")).toBe("application/json");
    expect(readCompareChanges(await dl.json()).pages[0]).toMatchObject({ page: 2, added: ["new words"] });
    expect(await runs(db)).toBe(1); // the change list is the same run
    const inline = await app.request(`${st.body.downloadUrl}?inline=1`, { headers: { cookie, host: "localhost" } });
    expect(inline.headers.get("content-disposition")).toMatch(/^inline/);
    expect((await upload(app, cookie, "/api/tools/editors/compare", ["v1.pdf"])).status).toBe(400);
    expect((await upload(app, cookie, "/api/tools/editors/compare", ["v1.pdf", "v2.docx"])).status).toBe(422);
  });

  it("job tokens do not cross workspaces, and P1 tokens are not editor tokens", async () => {
    const { app, cookie } = await setup();
    const t = await upload(app, cookie, "/api/tools/editors/jobs?op=thumbnails&name=a.pdf", ["a.pdf"]);
    const other = new Client(app);
    await other.signup(undefined, "Eve", "Other Co");
    expect((await other.get(`/api/tools/editors/jobs/${t.body!.token}`)).status).toBe(404);
    expect((await other.get(`/api/tools/editors/jobs/garbage.token`)).status).toBe(404);
  });

  it("stops a save at the plan's daily runs, but previews still show (R67)", async () => {
    const { app, cookie, db, engine } = await setup();
    const org = (await db.get<{ id: string }>(sql`select id from organizations limit 1`))!.id;
    const day = new Date().toISOString().slice(0, 10);
    await db.run(sql`insert into tool_usage (org_id, period, runs, bytes_in) values (${org}, ${day}, 100000, 0)`);
    const save = await upload(app, cookie, "/api/tools/editors/jobs?op=organize&name=a.pdf", ["a.pdf"], { plan: JSON.stringify([{ page: 1, rotate: 0 }]) });
    expect(save.status).toBe(403);
    expect(engine.jobs.size).toBe(0);
    const preview = await upload(app, cookie, "/api/tools/editors/jobs?op=thumbnails&name=a.pdf", ["a.pdf"]);
    expect(preview.status).toBe(202);
    expect(engine.jobs.size).toBe(1);
    expect(await runs(db)).toBe(100000);
  });

  describe("from mail attachments", () => {
    async function withMail() {
      const ctx = await setup();
      const { c, deps } = ctx;
      const domainId = await verifiedDomain(ctx, c, "acme.io");
      const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
      const send = async (messageId: string, subject: string, attachments: { filename: string; contentType: string; content: Uint8Array }[], inReplyTo?: string) => deliverInbound(deps, {
        envelopeFrom: "a@example.com", rcptTo: "me@acme.io", sizeBytes: 2000, via: "test",
        email: { messageId, inReplyTo, references: inReplyTo, from: { address: "a@example.com" }, to: [{ address: "me@acme.io" }], cc: [], subject, text: "Attached.", date: new Date(), attachments, authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
      });
      const enc = (s: string) => new TextEncoder().encode(s);
      await send("<v1@example.com>", "Contract", [{ filename: "Contract v1.pdf", contentType: "application/pdf", content: enc(PDF) }, { filename: "notes.txt", contentType: "text/plain", content: enc("hi") }]);
      await send("<v2@example.com>", "Re: Contract", [{ filename: "Contract v2.pdf", contentType: "application/pdf", content: enc(PDF) }], "<v1@example.com>");
      const list = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages as { id: string }[];
      const atts: { id: string; filename: string }[] = [];
      for (const m of list) atts.push(...((await c.get(`/api/mail/messages/${m.id}`)).body.message.attachments as { id: string; filename: string }[]));
      return { ...ctx, atts, find: (n: string) => atts.find((a) => a.filename === n)! };
    }

    it("lists the thread's other PDFs for compare", async () => {
      const { c, find } = await withMail();
      const r = await c.get(`/api/tools/editors/attachments/${find("Contract v2.pdf").id}/pdfs`);
      expect(r.status).toBe(200);
      const names = (r.body.attachments as { filename: string }[]).map((a) => a.filename).sort();
      expect(names).toEqual(["Contract v1.pdf", "Contract v2.pdf"]);
      expect((await c.get(`/api/tools/editors/attachments/att_nope/pdfs`)).status).toBe(404);
    });

    it("compares two attachments in a thread and fills a form from one, with clean options", async () => {
      const { c, engine, find, db } = await withMail();
      const r = await c.post("/api/tools/editors/jobs/from-attachments", { op: "compare", attachmentIds: [find("Contract v1.pdf").id, find("Contract v2.pdf").id] });
      expect(r.status).toBe(202);
      expect(r.body.report.name).toBe("Contract v2-changes.pdf");
      const f = await c.post("/api/tools/editors/jobs/from-attachments", { op: "form-fill", attachmentIds: [find("Contract v1.pdf").id], options: { values: JSON.stringify({ Name: "Jo" }), flatten: "yes", stray: "x" } });
      expect(f.status).toBe(202);
      const job = [...engine.jobs.values()].find((j) => j.op === "form-fill")!;
      expect(job.fields).toEqual({ values: "{\"Name\":\"Jo\"}", flatten: "yes" });
      expect(await runs(db)).toBe(0);
      await c.get(`/api/tools/editors/jobs/${r.body.report.token}`);
      await c.get(`/api/tools/editors/jobs/${r.body.changes.token}`);
      await c.get(`/api/tools/editors/jobs/${f.body.token}`);
      expect(await runs(db)).toBe(2);
      const audit = await db.all<{ metadata: string }>(sql`select metadata from audit_logs where action = 'tools.run'`);
      expect(audit.map((a) => JSON.parse(a.metadata).source)).toEqual(["attachment", "attachment"]);
    });

    it("refuses bad options, non PDFs and other workspaces' attachments", async () => {
      const { c, app, find, engine } = await withMail();
      const pdf = find("Contract v1.pdf").id;
      expect((await c.post("/api/tools/editors/jobs/from-attachments", { op: "organize", attachmentIds: [pdf], options: { plan: "not json" } })).status).toBe(400);
      expect((await c.post("/api/tools/editors/jobs/from-attachments", { op: "organize", attachmentIds: [pdf] })).status).toBe(400);
      expect((await c.post("/api/tools/editors/jobs/from-attachments", { op: "thumbnails", attachmentIds: [find("notes.txt").id] })).status).toBe(422);
      expect((await c.post("/api/tools/editors/jobs/from-attachments", { op: "compare", attachmentIds: [pdf] })).status).toBe(400);
      const other = new Client(app);
      await other.signup(undefined, "Eve", "Other Co");
      expect((await other.post("/api/tools/editors/jobs/from-attachments", { op: "thumbnails", attachmentIds: [pdf] })).status).toBe(404);
      expect((await other.get(`/api/tools/editors/attachments/${pdf}/pdfs`)).status).toBe(404);
      expect(engine.jobs.size).toBe(0);
    });
  });
});
