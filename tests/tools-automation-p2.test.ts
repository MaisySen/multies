/**
 * Tools P2 (automation): auto rules, workflows, templates, mail merge and composer attachments,
 * against a fake engine reached through the injected fetch (signatures checked like the P1 tests).
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { zipSync } from "fflate";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { MemoryToolFileStore } from "@/server/services/tools/p2-bindings";
import { reserveMergeQuota, unsubscribeUrl } from "@/server/services/tools/automation";
import { runDueJobs } from "@/server/services/jobs";
import {
  checkWorkflow, effectiveRules, fillTemplate, invoiceTotals, parseCsv, personalBody, ruleFor, BUILT_IN_TEMPLATES, mergeRowValues, mergeTemplateHtml,
} from "@/shared/tools-automation";

const ENGINE_KEY = "k".repeat(40);
const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "all" };
const PDF = "%PDF-1.4\n% fake\n";

interface Seen { op: string; fields: Record<string, string>; files: { name: string; text: string }[] }

function fakeEngine() {
  const jobs = new Map<string, { op: string; ws: string; rows?: { _file: string }[] }>();
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, url.pathname + url.search, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      const body = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer());
      const fd = await new Request("http://x/", { method: "POST", body, headers: { "content-type": h.get("content-type")! } }).formData();
      const fields: Record<string, string> = {};
      const files: Seen["files"] = [];
      for (const [k, v] of fd.entries()) {
        if (typeof v === "string") fields[k] = v; else files.push({ name: v.name, text: await v.text() });
      }
      const op = url.searchParams.get("op")!;
      seen.push({ op, fields, files });
      const id = Math.random().toString(16).slice(2).padEnd(16, "a") + "cafe";
      jobs.set(id, { op, ws, rows: fields.rows ? JSON.parse(fields.rows) : undefined });
      return Response.json({ id, op, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (m![2]) {
      if (job.op === "render-batch") {
        const z: Record<string, Uint8Array> = {};
        for (const r of job.rows ?? []) z[`${r._file}.pdf`] = new TextEncoder().encode(`${PDF}${r._file}`);
        const bytes = zipSync(z);
        return new Response(bytes, { headers: { "content-type": "application/zip" } });
      }
      return new Response(PDF, { headers: { "content-type": "application/pdf" } });
    }
    return Response.json({ id: m![1], op: job.op, status: "done", output: { bytes: PDF.length } });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

async function setup(env: Record<string, string> = ON) {
  const engine = fakeEngine();
  const ctx = await makeTestApp(env, { fetch: engine.fetch });
  ctx.deps.toolFiles = new MemoryToolFileStore();
  const c = new Client(ctx.app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const me = await c.get("/api/account/me");
  const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
  return { ...ctx, c, engine, orgId };
}

/** A verified domain and a mailbox to send from. */
async function mailbox(ctx: Awaited<ReturnType<typeof setup>>) {
  const domainId = (await ctx.c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await ctx.c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await ctx.c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  return (await ctx.c.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id as string;
}

async function uploadRun(ctx: Awaited<ReturnType<typeof setup>>, fields: Record<string, string>, files: { name: string; body: string }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new Blob([f.body], { type: "application/pdf" }), f.name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const req = new Request("http://localhost/x", { method: "POST", body: fd });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const res = await ctx.app.request("/api/tools/workflows/run", { method: "POST", headers: { cookie: ctx.c.cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" }, body: bytes });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const people = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com`, name: `Person ${i}`, data: {} }));

describe("Tools P2 automation: shared rules", () => {
  it("a person's rule wins over the workspace, which wins over the defaults", () => {
    expect(effectiveRules(null, null)).toEqual({ compress: false, compressOverMb: 5, wordPdf: false });
    const ws = { compress: "on" as const, compressOverMb: 4, wordPdf: "on" as const };
    expect(effectiveRules(ws, null)).toEqual({ compress: true, compressOverMb: 4, wordPdf: true });
    expect(effectiveRules(ws, { compress: "off", compressOverMb: null, wordPdf: null })).toEqual({ compress: false, compressOverMb: 4, wordPdf: true });
  });
  it("matches attachments to a rule", () => {
    const r = { compress: true, compressOverMb: 4, wordPdf: true };
    expect(ruleFor(r, { name: "Big.pdf", size: 5 * 1024 * 1024 })).toBe("compress");
    expect(ruleFor(r, { name: "Small.pdf", size: 3 * 1024 * 1024 })).toBeNull();
    expect(ruleFor(r, { name: "Letter.docx", size: 10 })).toBe("convert");
    expect(ruleFor({ ...r, wordPdf: false }, { name: "Letter.docx", size: 10 })).toBeNull();
    expect(ruleFor(r, { name: "photo.jpg", size: 9e9 })).toBeNull();
  });
  it("works out line totals, GST at 10 percent and the total", () => {
    const t = invoiceTotals([{ description: "Design", quantity: 2, unitPrice: 150 }, { description: "Hosting", quantity: 1, unitPrice: 19.99 }]);
    expect(t.rows.map((r) => r.total)).toEqual([300, 19.99]);
    expect(t).toMatchObject({ subtotal: 319.99, gst: 32, total: 351.99 });
    expect(invoiceTotals([{ description: "x", quantity: 1, unitPrice: 110 }], { gstIncluded: true })).toMatchObject({ subtotal: 100, gst: 10, total: 110 });
    expect(invoiceTotals([{ description: "x", quantity: 1, unitPrice: 100 }], { gst: false })).toMatchObject({ gst: 0, total: 100 });
  });
  it("fills a template with escaped values and repeated item rows", () => {
    const inv = BUILT_IN_TEMPLATES[0];
    const html = fillTemplate(inv, { business_name: "Acme <b>", client_name: "Bo", invoice_number: "INV-1", issue_date: "2026-10-30", lines: JSON.stringify([{ description: "A & B", quantity: 2, unitPrice: 50 }]) }, { workspaceName: "Acme", today: "2026-10-30" });
    expect(html).toContain("Acme &lt;b&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("$100.00");
    expect(html).toContain("$10.00");
    expect(html).toContain("$110.00");
    expect(html).toContain("30 October 2026");
    expect(html).not.toMatch(/\{\{/);
  });
  it("merge rows carry one line with totals worked out per person", () => {
    const inv = BUILT_IN_TEMPLATES[0];
    expect(mergeTemplateHtml(inv.html)).toContain("{{item}}");
    expect(mergeRowValues(inv, { client_name: "Bo", item: "Fee", qty: "2", unit_price: "$1,000" }, { workspaceName: "Acme", today: "2026-10-30" })).toMatchObject({ line_total: "$2,000.00", gst: "$200.00", total: "$2,200.00" });
  });
  it("checks workflow steps", () => {
    expect(checkWorkflow([{ op: "compress", options: {} }])).toMatch(/2 to 6/);
    expect(checkWorkflow([{ op: "ocr", options: {} }, { op: "compress", options: {} }])).toBeNull();
    expect(checkWorkflow([{ op: "compress", options: {} }, { op: "merge", options: {} }])).toMatch(/first step/);
    expect(checkWorkflow([{ op: "pdf-to-docx", options: {} }, { op: "compress", options: {} }])).toMatch(/last step/);
    expect(checkWorkflow([{ op: "compress", options: {} }, { op: "protect", options: { password: "x" } }])).toMatch(/Passwords/);
  });
  it("reads CSV with quotes and greets each person by first name", () => {
    expect(parseCsv('email,name\r\na@x.io,"Lee, Jo"\n\nb@x.io,"Say ""hi"""\n')).toEqual([["email", "name"], ["a@x.io", "Lee, Jo"], ["b@x.io", 'Say "hi"']]);
    const p = { email: "a@x.io", name: "Jo Lee", data: { amount: "5" } };
    expect(personalBody("Your invoice for {{amount}} is attached.", p)).toBe("Hi Jo,\n\nYour invoice for 5 is attached.");
    expect(personalBody("Dear {{first_name}}, see attached.", p)).toBe("Dear Jo, see attached.");
  });
});

describe("Tools P2 automation API", () => {
  it("every route is a 404 while its flag is off", async () => {
    const { c } = await setup({ ...ON, TOOLS_FEATURES: "editor" });
    for (const p of ["/api/tools/rules", "/api/tools/workflows", "/api/tools/templates", "/api/tools/merge"]) expect((await c.get(p)).status).toBe(404);
  });

  it("saves workspace rules and a person's own override", async () => {
    const { c } = await setup();
    expect((await c.get("/api/tools/rules")).body.effective).toEqual({ compress: false, compressOverMb: 5, wordPdf: false });
    await c.put("/api/tools/rules/workspace", { compress: "on", compressOverMb: 4, wordPdf: "on" });
    const mine = await c.put("/api/tools/rules/mine", { compress: null, compressOverMb: 2, wordPdf: "off" });
    expect(mine.body.effective).toEqual({ compress: true, compressOverMb: 2, wordPdf: false });
    expect((await c.put("/api/tools/rules/mine", { compress: null, compressOverMb: 900, wordPdf: null })).status).toBe(422);
  });

  it("saves a workflow and runs it as one chain job; a password is asked each run and never stored", async () => {
    const ctx = await setup();
    const { c, engine } = ctx;
    const bad = await c.post("/api/tools/workflows", { name: "x", steps: [{ op: "compress", options: {} }, { op: "protect", options: { password: "secret1" } }] });
    expect(bad.status).toBe(400);
    const wf = await c.post("/api/tools/workflows", { name: "Shrink and lock", steps: [{ op: "compress", options: { level: "strong" } }, { op: "protect", options: {} }], finish: "email" });
    expect(wf.status).toBe(201);
    const list = await c.get("/api/tools/workflows");
    expect(list.body.starters.map((s: { name: string }) => s.name)).toEqual(["Scan to searchable PDF", "Shrink and protect", "Word to PDF and watermark"]);
    expect(list.body.workflows[0].name).toBe("Shrink and lock");
    const noPw = await uploadRun(ctx, { workflowId: wf.body.id }, [{ name: "a.pdf", body: PDF }]);
    expect(noPw.status).toBe(400);
    const run = await uploadRun(ctx, { workflowId: wf.body.id, password: "hunter22" }, [{ name: "a.pdf", body: PDF }]);
    expect(run.status).toBe(202);
    const job = engine.seen.at(-1)!;
    expect(job.op).toBe("chain");
    expect(JSON.parse(job.fields.steps)).toEqual([{ op: "compress", options: { level: "strong" } }, { op: "protect", options: { password: "hunter22" } }]);
    const stored = await ctx.db.all<{ steps: string }>(sql`select steps from tool_workflows`);
    expect(stored[0].steps).not.toContain("hunter22");
    // The P1 poll route reads the token and hands back a download link.
    const poll = await c.get(`/api/tools/jobs/${run.body.token}`);
    expect(poll.body).toMatchObject({ status: "done", op: "chain" });
    expect(poll.body.downloadUrl).toMatch(/^\/api\/tools\/jobs\/.+\/download$/);
    // A starter runs too.
    expect((await uploadRun(ctx, { workflowId: "starter-word-watermark" }, [{ name: "a.docx", body: "doc" }])).status).toBe(202);
  });

  it("renders the invoice template as a PDF through the engine, with totals", async () => {
    const { c, engine } = await setup();
    const list = await c.get("/api/tools/templates");
    expect(list.body.templates.map((t: { id: string }) => t.id).slice(0, 3)).toEqual(["builtin-invoice", "builtin-quote", "builtin-letter"]);
    expect(list.body.workspaceName).toBe("Acme");
    const missing = await c.post("/api/tools/templates/builtin-invoice/render", { values: { business_name: "Acme" } });
    expect(missing.status).toBe(400);
    const r = await c.post("/api/tools/templates/builtin-invoice/render", { values: { business_name: "Acme", client_name: "Bo <x>", invoice_number: "7", issue_date: "2026-10-30", lines: [{ description: "Work", quantity: 3, unitPrice: 100 }] } });
    expect(r.status).toBe(202);
    expect(r.body.name).toBe("invoice-7.pdf");
    const job = engine.seen.at(-1)!;
    expect(job.op).toBe("render");
    expect(job.files[0].text).toContain("Bo &lt;x&gt;");
    expect(job.files[0].text).toContain("$330.00");
  });

  it("refuses custom templates with scripts, remote files or fields it doesn't define", async () => {
    const { c } = await setup();
    const fields = [{ key: "client", label: "Client", type: "text" }];
    expect((await c.post("/api/tools/templates", { name: "x", html: "<p>{{client}}</p><script>1</script>", fields })).body.error.message).toMatch(/scripts/);
    expect((await c.post("/api/tools/templates", { name: "x", html: '<img src="https://e.com/a.png">{{client}}', fields })).body.error.message).toMatch(/other websites/);
    expect((await c.post("/api/tools/templates", { name: "x", html: "<p>{{client}} {{amount}}</p>", fields })).body.error.message).toMatch(/amount/);
    const ok = await c.post("/api/tools/templates", { name: "Receipt", html: "<p>{{workspace_name}} thanks {{client}}</p>", fields });
    expect(ok.status).toBe(201);
    expect((await c.get("/api/tools/templates")).body.templates.some((t: { name: string }) => t.name === "Receipt")).toBe(true);
  });

  it("mail merge refuses without the consent tick and cannot pass the daily cap", async () => {
    const ctx = await setup();
    const { c, engine } = ctx;
    const mailboxId = await mailbox(ctx);
    const base = { templateId: "builtin-letter", mailboxId, subject: "Hello {{first_name}}", body: "Your letter is attached." };
    const before = engine.seen.length;
    const noConsent = await c.post("/api/tools/merge", { ...base, people: people(2), consent: false });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.error.code).toBe("consent_required");
    expect(engine.seen.length).toBe(before);
    // Free plan: 50 a day. 51 at once is refused; 30 then 30 refuses the second.
    const tooMany = await c.post("/api/tools/merge", { ...base, people: people(51), consent: true });
    expect(tooMany.status).toBe(403);
    expect(tooMany.body.error.message).toMatch(/50 people a day/);
    expect((await c.post("/api/tools/merge", { ...base, people: people(30), consent: true })).status).toBe(201);
    const second = await c.post("/api/tools/merge", { ...base, people: people(30, "q"), consent: true });
    expect(second.status).toBe(403);
    expect(second.body.error.message).toMatch(/20 left today/);
    expect((await c.get("/api/tools/merge")).body).toMatchObject({ cap: 50, usedToday: 30 });
  });

  it("concurrent reservations never pass the cap", async () => {
    const ctx = await setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveMergeQuota(ctx.deps, ctx.orgId, 5, 50)));
    expect(results.filter(Boolean).length).toBe(10);
    const row = await ctx.db.get<{ n: number }>(sql`select n from merge_daily where org_id = ${ctx.orgId}`);
    expect(row!.n).toBe(50);
  });

  it("sends one email per person with their own PDF, spread over time, with unsubscribe for marketing", async () => {
    const ctx = await setup();
    const { c, engine } = ctx;
    const mailboxId = await mailbox(ctx);
    const run = await c.post("/api/tools/merge", { templateId: "builtin-letter", mailboxId, subject: "Your letter, {{first_name}}", body: "It is attached.", consent: true, marketing: true,
      people: [{ email: "jo@example.com", name: "Jo Lee", data: { body: "Hi" } }, { email: "sam@example.com", name: "Sam Wu", data: {} }, { email: "JO@example.com", name: "dup", data: {} }] });
    expect(run.status).toBe(201);
    expect(run.body.total).toBe(2);
    const batch = engine.seen.at(-1)!;
    expect(batch.op).toBe("render-batch");
    expect(JSON.parse(batch.fields.rows)).toHaveLength(2);
    const prog = await c.get(`/api/tools/merge/${run.body.id}`);
    expect(prog.body.status).toBe("sending");
    // The first send is due now, the second 6 seconds later.
    await runDueJobs(ctx.deps, 10, { types: ["tools.merge_send"] });
    expect((await c.get(`/api/tools/merge/${run.body.id}`)).body).toMatchObject({ sent: 1, status: "sending" });
    const real = ctx.deps.now;
    ctx.deps.now = () => new Date(real().getTime() + 60_000);
    await runDueJobs(ctx.deps, 10, { types: ["tools.merge_send"] });
    ctx.deps.now = real;
    expect((await c.get(`/api/tools/merge/${run.body.id}`)).body).toMatchObject({ sent: 2, failed: 0, status: "done" });
    const mails = ctx.outbound.sent.filter((m) => m.subject.startsWith("Your letter"));
    expect(mails.map((m) => m.subject).sort()).toEqual(["Your letter, Jo", "Your letter, Sam"]);
    const jo = mails.find((m) => m.to[0] === "jo@example.com")!;
    expect(jo.text.startsWith("Hi Jo,")).toBe(true);
    expect(jo.text).toContain("unsubscribe here: http");
    expect(jo.attachments?.[0]).toMatchObject({ filename: "Jo Lee.pdf", contentType: "application/pdf" });
    expect(new TextDecoder().decode(jo.attachments![0].content)).toContain(PDF);

    // Unsubscribe: the link shows a button, the button (confirm=1) records it, the next marketing merge skips them.
    const url = new URL(await unsubscribeUrl(ctx.deps, ctx.orgId, "jo@example.com"));
    expect((await ctx.app.request(url.pathname + url.search)).status).toBe(200);
    expect((await ctx.app.request(url.pathname + url.search.replace(/s=[^&]+/, "s=" + "0".repeat(32)))).status).toBe(400);
    const page = await (await ctx.app.request(url.pathname + url.search)).text();
    expect(page).toContain('name="confirm" value="1"');
    expect((await ctx.db.all(sql`select email from merge_unsubscribes`)).length).toBe(0);
    expect((await ctx.app.request(url.pathname + url.search + "&confirm=1")).status).toBe(200);
    const again = await c.post("/api/tools/merge", { templateId: "builtin-letter", mailboxId, subject: "x", body: "y", consent: true, marketing: true, people: [{ email: "jo@example.com", name: "Jo", data: {} }, { email: "kim@example.com", name: "Kim", data: {} }] });
    expect(again.body).toMatchObject({ total: 1, skippedUnsubscribed: 1 });
  });

  it("cancelling a run skips the queued sends and gives back today's allowance", async () => {
    const ctx = await setup();
    const mailboxId = await mailbox(ctx);
    const run = await ctx.c.post("/api/tools/merge", { templateId: "builtin-letter", mailboxId, subject: "s", body: "b", consent: true, people: people(4) });
    // Watching the progress view renders the PDFs and sends what is due now (the first person; the rest are spaced).
    const first = await ctx.c.get(`/api/tools/merge/${run.body.id}`);
    expect(first.body).toMatchObject({ status: "sending", sent: 1 });
    const done = await ctx.c.post(`/api/tools/merge/${run.body.id}/cancel`);
    expect(done.body.status).toBe("cancelled");
    expect((await ctx.c.get("/api/tools/merge")).body.usedToday).toBe(1);
    await runDueJobs(ctx.deps, 10, { types: ["tools.merge_send"] });
    expect(ctx.outbound.sent.filter((m) => m.subject === "s")).toHaveLength(1);
  });
});

describe("composer attachments", () => {
  it("sends files attached in the composer through the send service", async () => {
    const ctx = await setup();
    const mailboxId = await mailbox(ctx);
    const data = Buffer.from(PDF).toString("base64");
    const r = await ctx.c.post("/api/mail/send", { mailboxId, to: ["x@example.com"], subject: "With file", text: "See attached", attachments: [{ filename: "a.pdf", contentType: "application/pdf", data }] });
    expect(r.status).toBe(201);
    const m = ctx.outbound.sent.find((x) => x.subject === "With file")!;
    expect(m.attachments?.[0]).toMatchObject({ filename: "a.pdf", contentType: "application/pdf" });
    expect(new TextDecoder().decode(m.attachments![0].content)).toBe(PDF);
    expect((await ctx.c.post("/api/mail/send", { mailboxId, to: ["x@example.com"], subject: "No file", text: "x" })).status).toBe(201);
  });
});

describe("Tools developer API", () => {
  async function apiCall(ctx: Awaited<ReturnType<typeof setup>>, key: string, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
    const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...headers }, body });
    const text = await res.text();
    let json: Record<string, unknown> | string = text;
    try { json = JSON.parse(text); } catch { /* a file */ }
    return { status: res.status, body: json as Record<string, any>, text }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const upload = () => { const fd = new FormData(); fd.append("files", new Blob([PDF], { type: "application/pdf" }), "a.pdf"); fd.append("text", "DRAFT"); fd.append("bogus", "x"); return fd; };

  it("lists tools, runs a job from a multipart upload, polls it and downloads the result", async () => {
    const ctx = await setup();
    const key = (await ctx.c.post("/api/developer/keys", { name: "ci", scope: ["tools:read", "tools:run"] })).body.secret as string;
    const list = await apiCall(ctx, key, "GET", "/tools");
    expect(list.status).toBe(200);
    expect(list.body.tools.some((t: { op: string }) => t.op === "compress")).toBe(true);
    expect(list.body.workflows.map((w: { name: string }) => w.name)).toContain("Scan to searchable PDF");
    const job = await apiCall(ctx, key, "POST", "/tools/jobs?op=watermark", upload());
    expect(job.status).toBe(202);
    expect(ctx.engine.seen.at(-1)).toMatchObject({ op: "watermark", fields: { text: "DRAFT" } });
    expect(ctx.engine.seen.at(-1)!.fields.bogus).toBeUndefined();
    const st = await apiCall(ctx, key, "GET", `/tools/jobs/${job.body.token}`);
    expect(st.body.status).toBe("done");
    const file = await apiCall(ctx, key, "GET", String(st.body.downloadUrl).replace("/api/v1", ""));
    expect(file.status).toBe(200);
    expect(file.text).toBe(PDF);
    const wf = await apiCall(ctx, key, "POST", "/tools/workflows/starter-word-watermark/run", (() => { const fd = new FormData(); fd.append("files", new Blob(["doc"]), "a.docx"); return fd; })());
    expect(wf.status).toBe(202);
    expect(ctx.engine.seen.at(-1)!.op).toBe("chain");
  });

  it("needs the tools scope, a write scope to run, and the api flag", async () => {
    const ctx = await setup();
    const mailKey = (await ctx.c.post("/api/developer/keys", { name: "m", scope: ["mail:read"] })).body.secret as string;
    const no = await apiCall(ctx, mailKey, "GET", "/tools");
    expect(no.status).toBe(403);
    expect(no.body.error.required).toBe("tools:read");
    const readKey = (await ctx.c.post("/api/developer/keys", { name: "r", scope: ["tools:read"] })).body.secret as string;
    expect((await apiCall(ctx, readKey, "GET", "/tools")).status).toBe(200);
    expect((await apiCall(ctx, readKey, "POST", "/tools/jobs?op=compress", upload())).body.error.required).toBe("tools:run");
    const off = await setup({ ...ON, TOOLS_FEATURES: "workflows" });
    const k2 = (await off.c.post("/api/developer/keys", { name: "f" })).body.secret as string;
    expect((await apiCall(off, k2, "GET", "/tools")).status).toBe(404);
  });
});
