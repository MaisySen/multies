/**
 * Tools P2 integration (H8): one attachment row and one limit for Tools results (tokens) and composer files (base64),
 * the editors in the served catalogue, toolFeatures in /api/config, command menu entries per feature, the cron passes
 * gated by feature, and the single "Attach to a new email" helper.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world"; // PRIV1b (P36): only a verified domain routes mail
import { OCR_SLOW_NOTE, batchTools, catalogueFor, toolsForFile, type ToolsInfo } from "@/shared/tools";
import { deliverInbound } from "@/server/services/mail/delivery";
import { toolsCronPasses } from "@/server/services/tools/p2-cron";
import { attachToNewEmail, takePendingCompose, toolFileRefs } from "@/web/lib/compose-files";
import { flagOn } from "@/web/lib/commands/registry";
import { PALETTE_PAGES } from "@/web/lib/palette-registry";

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
  const domainId = await verifiedDomain(s, s.c, "acme.io");
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


const b64 = (s: string | Uint8Array) => Buffer.from(typeof s === "string" ? s : s).toString("base64");

async function resultToken(s: Awaited<ReturnType<typeof withMail>>, name = "Big.pdf") {
  const r = await upload(s.app, s.c.cookie, "compress", name);
  const st = (await s.c.get(`/api/tools/jobs/${r.body!.token}`)).body as { downloadUrl: string; name: string; bytes: number };
  return toolFileRefs([st])[0].token;
}

describe("One attachment row: Tools results and composer files share one limit", () => {
  it("sends a composer file and a Tools result together in one email", async () => {
    const s = await withMail("");
    await s.db.run(sql`update domains set status = 'verified' where name = 'acme.io'`);
    s.engine.setOutput("application/pdf", "%PDF-result");
    const tok = await resultToken(s);
    const sent = await s.c.post("/api/mail/send", { mailboxId: s.box.id, to: ["me@acme.io"], subject: "Both", text: "Here", toolFiles: [tok], attachments: [{ filename: "notes.txt", contentType: "text/plain", data: b64("hello") }] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const names = (await s.db.all<{ filename: string }>(sql`select filename from attachments where filename in ('notes.txt', 'Big-compressed.pdf')`)).map((r) => r.filename).sort();
    expect(names).toEqual(expect.arrayContaining(["Big-compressed.pdf", "notes.txt"]));
  });

  it("refuses an 11th file across both kinds, and a Tools result past 20 MB in all", async () => {
    const s = await withMail("");
    await s.db.run(sql`update domains set status = 'verified' where name = 'acme.io'`);
    const tok = await resultToken(s);
    const ten = Array.from({ length: 10 }, (_, i) => ({ filename: `f${i}.txt`, contentType: "text/plain", data: b64("x") }));
    const many = await s.c.post("/api/mail/send", { mailboxId: s.box.id, to: ["me@acme.io"], subject: "x", text: "x", toolFiles: [tok], attachments: ten });
    expect(many.status).toBe(400);
    expect(JSON.stringify(many.body)).toMatch(/up to 10 files/);
    const big = await s.c.post("/api/mail/send", { mailboxId: s.box.id, to: ["me@acme.io"], subject: "x", text: "x", toolFiles: [tok], attachments: [{ filename: "big.bin", contentType: "application/octet-stream", data: b64(new Uint8Array(20 * 1024 * 1024 - 4)) }] });
    expect(big.status).toBe(400);
    expect(JSON.stringify(big.body)).toMatch(/20 MB/);
    const n = await s.db.get<{ n: number }>(sql`select count(*) as n from messages where folder = 'sent'`);
    expect(n?.n ?? 0).toBe(0);
  });
});

describe("Editors in the served catalogue", () => {
  it("GET /api/tools lists the editors with their page and webOnly when their flags are on, and not otherwise", async () => {
    const on = (await (await setup("editor,forms,compare")).c.get("/api/tools")).body as ToolsInfo;
    const byOp = Object.fromEntries(on.tools.map((t) => [t.op, t]));
    expect(byOp.organize).toMatchObject({ path: "/app/tools/pages", webOnly: true, feature: "editor" });
    expect(byOp["form-fill"]).toMatchObject({ path: "/app/tools/forms", feature: "forms" });
    expect(byOp.compare).toMatchObject({ path: "/app/tools/compare", webOnly: true, feature: "compare" });
    const off = (await (await setup("")).c.get("/api/tools")).body as ToolsInfo;
    expect(off.tools.some((t) => t.path)).toBe(false);
  });

  it("keeps editor pages out of the plain attachment menu and batch (they open their own page)", () => {
    const all = ["editor", "forms", "compare", "batch"];
    expect(toolsForFile("Contract.pdf", all).some((t) => t.path)).toBe(false);
    expect(batchTools(all).some((t) => t.path)).toBe(false);
  });

  it("says other OCR languages are slow, only when they are offered", () => {
    const lang = (f: string[]) => catalogueFor(f).find((t) => t.op === "ocr")!.options.find((o) => o.name === "language")!;
    expect(lang(["ocr_langs"]).help).toBe(OCR_SLOW_NOTE);
    expect(lang([]).help).toBeUndefined();
  });
});

describe("Wiring", () => {
  it("/api/config carries toolFeatures while Tools is on, and none when it is off", async () => {
    const on = await setup("share,esign");
    expect((await on.c.get("/api/config")).body.toolFeatures).toEqual(["share", "esign"]);
    const off = await makeTestApp({ TOOLS_FEATURES: "share" });
    expect((await new Client(off.app).get("/api/config")).body.toolFeatures).toEqual([]);
  });

  it("command menu entries follow each feature, not only the Tools switch", () => {
    const sign = PALETTE_PAGES.find((p) => p.id === "p-tools-sign")!;
    const tools = PALETTE_PAGES.find((p) => p.id === "p-tools")!;
    expect(flagOn(sign, { tools: true, toolFeatures: [] })).toBe(false);
    expect(flagOn(sign, { tools: true, toolFeatures: ["esign"] })).toBe(true);
    expect(flagOn(sign, { tools: false, toolFeatures: ["esign"] })).toBe(false);
    expect(flagOn(tools, { tools: true, toolFeatures: [] })).toBe(true);
  });

  it("cron: no Tools pass without its feature, every pass with them, none throws", async () => {
    const none = await setup("");
    expect(toolsCronPasses(none.deps)).toHaveLength(0);
    const all = await setup("all");
    const passes = toolsCronPasses(all.deps);
    expect(passes).toHaveLength(5); // R88: file request upload prune
    await expect(Promise.all(passes)).resolves.toBeDefined();
  });
});

describe("The one Attach to a new email helper", () => {
  it("hands over tokens for engine results and files for local files, 10 in all, once", () => {
    const seen: string[] = [];
    const jobs = Array.from({ length: 8 }, (_, i) => ({ downloadUrl: `/api/tools/jobs/tok${i}/download`, name: `r${i}.pdf` }));
    const editor = { downloadUrl: "/api/tools/editors/jobs/edtok/download", name: "edited.pdf" };
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt"), new File(["c"], "c.txt")];
    attachToNewEmail((to) => seen.push(to), { jobs: [...jobs, editor], files }, { subject: "Hi" });
    expect(seen).toEqual(["/app/mail?compose=files"]);
    const p = takePendingCompose()!;
    expect(p.toolFiles!.map((t) => t.token)).toEqual([...jobs.map((_, i) => `tok${i}`), "edtok"]);
    expect(p.files!.map((f) => f.name)).toEqual(["a.txt"]);
    expect(p.subject).toBe("Hi");
    expect(takePendingCompose()).toBeNull();
  });
});
