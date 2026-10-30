/**
 * Tools P1: the document tools API (/api/tools) against a fake engine reached through the injected fetch.
 * The fake engine checks every signature with its own HMAC code (node:crypto), like the real engine does.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { canonical, signEngine } from "@/server/services/tools/engine-client";
import { mintToken, readToken } from "@/server/services/tools/tokens";
import { dayOf, monthOf } from "@/server/services/tools/usage";
import { resultName } from "@/shared/tools";
import { loadConfig } from "@/server/config";

const VECTOR = JSON.parse(readFileSync("tests/fixtures/tools-signing-vector.json", "utf8")) as Record<string, string>;
const ENGINE_KEY = "k".repeat(40);
const TOKEN_KEY = "t".repeat(40);
const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: TOKEN_KEY };
const PDF = "%PDF-1.4\n% fake pdf for tests\n";

interface FakeJob { id: string; ws: string; op: string; bytes: number; status: string }

/** A fake engine: verifies the signature and the body length, keeps jobs per workspace. */
function fakeEngine() {
  const jobs = new Map<string, FakeJob>();
  const seen: { path: string; ws: string; user: string; len: string; maxBytes: string; ctype: string | null }[] = [];
  let down = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (down) throw new Error("connect ECONNREFUSED");
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    const pathQs = url.pathname + url.search;
    let bodyLen = 0;
    if (init?.body) bodyLen = (await new Response(init.body as BodyInit).arrayBuffer()).byteLength;
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, pathQs, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-key") !== "stg-1" || h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (init?.body && String(bodyLen) !== len) return Response.json({ error: "length mismatch" }, { status: 400 });
    const ws = h.get("x-multies-ws")!;
    seen.push({ path: pathQs, ws, user: h.get("x-multies-user")!, len, maxBytes: h.get("x-multies-max-bytes")!, ctype: h.get("content-type") });
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      const id = Math.random().toString(16).slice(2).padEnd(16, "a") + "beef";
      jobs.set(id, { id, ws, op: url.searchParams.get("op")!, bytes: bodyLen, status: "done" });
      return Response.json({ id, op: url.searchParams.get("op"), status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (m![2]) return new Response(PDF, { headers: { "content-type": "application/pdf", "content-length": String(PDF.length) } });
    return Response.json({ id: job.id, op: job.op, status: job.status, output: { name: "compressed.pdf", bytes: PDF.length, content_type: "application/pdf" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, seen, setDown: (v: boolean) => { down = v; } };
}

function form(files: { name: string; body: string }[]) {
  const fd = new FormData();
  for (const f of files) fd.append("files", new Blob([f.body], { type: "application/pdf" }), f.name);
  return fd;
}

async function upload(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, cookie: string, op: string, files: { name: string; body: string }[], opts: { noLength?: boolean; noHeader?: boolean; query?: string } = {}) {
  const req = new Request("http://localhost/x", { method: "POST", body: form(files) });
  const bytes = new Uint8Array(await req.arrayBuffer());
  const headers: Record<string, string> = { cookie, host: "localhost", "content-type": req.headers.get("content-type")! };
  if (!opts.noLength) headers["content-length"] = String(bytes.byteLength);
  if (!opts.noHeader) headers["x-multies-upload"] = "1";
  const q = opts.query ?? `op=${op}&files=${files.length}&name=${encodeURIComponent(files[0]?.name ?? "")}`;
  const res = await app.request(`/api/tools/jobs?${q}`, { method: "POST", headers, body: bytes });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null, sent: bytes.byteLength };
}

async function setup(env: Record<string, string> = ON) {
  const engine = fakeEngine();
  const ctx = await makeTestApp(env, { fetch: engine.fetch });
  const c = new Client(ctx.app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const me = await c.get("/api/account/me");
  const orgId = (me.body as { organization?: { id: string } }).organization?.id ?? "";
  return { ...ctx, c, engine, orgId };
}

describe("Tools P1 signing", () => {
  it("matches the shared vector the engine's Python verifier also checks", async () => {
    const v = VECTOR;
    expect(canonical(v.method, v.path_qs, v.ts, v.nonce, v.ws, v.user, v.max_bytes, v.content_length)).toBe(v.canonical);
    expect(await signEngine(v.secret, v.method, v.path_qs, v.ts, v.nonce, v.ws, v.user, v.max_bytes, v.content_length)).toBe(v.signature);
  });
  it("is off unless the switch, an engine address and both long keys are set", () => {
    expect(loadConfig({ APP_SECRET: "t".repeat(40) }).tools.enabled).toBe(false);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), ...ON }).tools.enabled).toBe(true);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), ...ON, TOOLS_ENABLED: "false" }).tools.enabled).toBe(false);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), ...ON, DOC_ENGINE_KEY: "short" }).tools.enabled).toBe(false);
    expect(loadConfig({ APP_SECRET: "t".repeat(40), ...ON, DOC_ENGINE_URL: "http://engine.test" }).tools.enabled).toBe(false);
  });
  it("tokens refuse tampering, the wrong kind and expiry", async () => {
    const now = Date.now();
    const tok = await mintToken(TOKEN_KEY, { k: "s", j: "a".repeat(32), w: "org_1", u: "usr_1", o: "compress", n: "x.pdf" }, now);
    expect((await readToken(TOKEN_KEY, tok, "s", now))?.w).toBe("org_1");
    expect(await readToken(TOKEN_KEY, tok, "d", now)).toBeNull();
    expect(await readToken("x".repeat(40), tok, "s", now)).toBeNull();
    const [p, s] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), w: "org_2" })).toString("base64url");
    expect(await readToken(TOKEN_KEY, `${forged}.${s}`, "s", now)).toBeNull();
    expect(await readToken(TOKEN_KEY, tok, "s", now + 2 * 3600_000 + 1000)).toBeNull();
  });
  it("names results from the first file, without odd characters", () => {
    expect(resultName("compress", "Invoice 12.pdf")).toBe("Invoice 12-compressed.pdf");
    expect(resultName("merge", "a/b\\c<d>.pdf")).toBe("a b c d-merged.pdf");
    expect(resultName("convert", "Report.docx")).toBe("Report.pdf");
    expect(resultName("compress", "")).toBe("document-compressed.pdf");
  });
});

describe("Tools P1 API", () => {
  it("is a 404 when the deployment has Tools off", async () => {
    const { c, app } = await setup({});
    expect((await c.get("/api/tools")).status).toBe(404);
    expect((await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }])).status).toBe(404);
    expect(((await c.get("/api/config")).body as { tools: boolean }).tools).toBe(false);
  });

  it("lists the tools with this month's usage and the Free plan limits", async () => {
    const { c } = await setup();
    const r = await c.get("/api/tools");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, usage: { month: 0, day: 0 }, limits: { runsMonthly: 100, runsDaily: 30, maxBytes: 20 * 1024 * 1024, maxMergeFiles: 10 } });
    expect((r.body as { tools: { op: string }[] }).tools).toHaveLength(13);
    expect(((await c.get("/api/config")).body as { tools: boolean }).tools).toBe(true);
  });

  it("runs a compress end to end: signed upload streamed whole, one usage upsert, an audit row without the file name, status, download", async () => {
    const { c, app, db, engine, orgId } = await setup();
    const up = await upload(app, c.cookie, "compress", [{ name: "Secret invoice.pdf", body: PDF.repeat(20) }]);
    expect(up.status).toBe(202);
    expect(up.body).toMatchObject({ op: "compress", status: "queued", name: "Secret invoice-compressed.pdf" });
    const sent = engine.seen[0];
    expect(sent).toMatchObject({ path: "/internal/v1/jobs?op=compress", ws: orgId, len: String(up.sent) });
    expect(sent.ctype).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(sent.maxBytes)).toBe(20 * 1024 * 1024 + 64 * 1024);
    const now = new Date();
    const rows = await db.all<{ period: string; runs: number; bytes_in: number }>(sql`select period, runs, bytes_in from tool_usage where org_id = ${orgId} order by period`);
    expect(rows).toEqual([{ period: monthOf(now), runs: 1, bytes_in: up.sent }, { period: dayOf(now), runs: 1, bytes_in: up.sent }]);
    const auditRows = await db.all<{ action: string; target_type: string; metadata: string }>(sql`select action, target_type, metadata from audit_logs where org_id = ${orgId} and action = 'tools.run'`);
    expect(auditRows).toHaveLength(1);
    expect(JSON.parse(auditRows[0].metadata)).toEqual({ op: "compress", source: "upload", files: 1, bytes_in: up.sent });
    expect(auditRows[0].metadata).not.toContain("invoice");
    const st = await c.get(`/api/tools/jobs/${up.body!.token}`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ status: "done", name: "Secret invoice-compressed.pdf", bytes: PDF.length });
    const dl = await app.request((st.body as { downloadUrl: string }).downloadUrl, { headers: { cookie: c.cookie, host: "localhost" } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/pdf");
    expect(dl.headers.get("content-disposition")).toContain("Secret%20invoice-compressed.pdf");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await dl.text()).startsWith("%PDF")).toBe(true);
    // A second run adds to the same two rows.
    await upload(app, c.cookie, "merge", [{ name: "a.pdf", body: PDF }, { name: "b.pdf", body: PDF }]);
    const after = await db.all<{ runs: number }>(sql`select runs from tool_usage where org_id = ${orgId}`);
    expect(after.map((r) => r.runs)).toEqual([2, 2]);
  });

  it("keeps the run's usage to one write statement", () => {
    const src = readFileSync("src/server/services/tools/usage.ts", "utf8");
    const body = src.slice(src.indexOf("export async function recordRun"), src.indexOf("export async function pruneToolUsage"));
    expect(body.match(/db\.(run|insert|update|get|all)\(/g)).toHaveLength(1);
  });

  it("refuses uploads over the plan cap (413), without a size (411), without the upload header (403) and for unknown tools (400)", async () => {
    const { c, app, engine } = await setup();
    const big = await upload(app, c.cookie, "compress", [{ name: "big.pdf", body: "x".repeat(20 * 1024 * 1024 + 70 * 1024) }]);
    expect(big.status).toBe(413);
    expect((await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }], { noLength: true })).status).toBe(411);
    const noHeader = await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }], { noHeader: true });
    expect(noHeader.status).toBe(403);
    expect((await upload(app, c.cookie, "replace", [{ name: "a.pdf", body: PDF }], { query: "op=replace" })).status).toBe(400);
    expect(engine.seen).toHaveLength(0);
  });

  it("answers 403 plan_limit at the month cap and at the day cap, and caps merge files by plan", async () => {
    const { c, app, db, orgId } = await setup();
    const now = new Date();
    await db.run(sql`insert into tool_usage (org_id, period, runs, bytes_in) values (${orgId}, ${dayOf(now)}, 30, 0)`);
    const day = await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }]);
    expect(day.status).toBe(403);
    expect(day.body).toMatchObject({ error: { code: "plan_limit" } });
    expect(JSON.stringify(day.body)).toContain("today");
    await db.run(sql`insert into tool_usage (org_id, period, runs, bytes_in) values (${orgId}, ${monthOf(now)}, 100, 0)`);
    const month = await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }]);
    expect(month.status).toBe(403);
    expect(JSON.stringify(month.body)).toContain("this month");
    await db.run(sql`delete from tool_usage`);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.pdf`, body: PDF }));
    expect((await upload(app, c.cookie, "merge", eleven)).status).toBe(403);
  });

  it("is a 404 for a workspace whose admins switched Tools off", async () => {
    const { c, app, db, orgId } = await setup();
    await db.run(sql`update organizations set tools_mode = 'off' where id = ${orgId}`);
    expect((await c.get("/api/tools")).status).toBe(404);
    expect((await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }])).status).toBe(404);
  });

  it("lets a workspace admin switch Tools off and back on from Settings (R63), with an audit row each time", async () => {
    const { c, db, orgId } = await setup();
    expect((await c.get("/api/tools/settings")).body).toEqual({ on: true });
    const off = await c.put("/api/tools/settings", { on: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ on: false });
    expect((await c.get("/api/tools/settings")).body).toEqual({ on: false });
    expect((await c.get("/api/tools")).status).toBe(404);
    expect((await c.put("/api/tools/settings", { on: true })).body).toEqual({ on: true });
    expect((await c.get("/api/tools")).status).toBe(200);
    const rows = await db.all<{ action: string }>(sql`select action from audit_logs where org_id = ${orgId} and action like 'tools.turned_%' order by created_at`);
    expect(rows.map((r) => r.action)).toEqual(["tools.turned_off", "tools.turned_on"]);
    expect((await c.put("/api/tools/settings", { on: "no" })).status).toBe(422);
  });

  it("keeps the switch to admins, and the settings route is a 404 where the deployment has Tools off", async () => {
    const { c, db, orgId } = await setup();
    await db.run(sql`update members set role = 'member' where organization_id = ${orgId}`);
    expect((await c.put("/api/tools/settings", { on: false })).status).toBe(403);
    const off = await setup({});
    expect((await off.c.get("/api/tools/settings")).status).toBe(404);
    expect((await off.c.put("/api/tools/settings", { on: false })).status).toBe(404);
  });

  it("refuses a tampered, expired or other workspace's token with 404", async () => {
    const { c, app, deps } = await setup();
    const up = await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }]);
    const token = String(up.body!.token);
    expect((await c.get(`/api/tools/jobs/${token.slice(0, -2)}xx`)).status).toBe(404);
    const other = new Client(app);
    await other.signup(undefined, "Grace Hopper", "Other Co");
    expect((await other.get(`/api/tools/jobs/${token}`)).status).toBe(404);
    const st = await c.get(`/api/tools/jobs/${token}`);
    const dl = (st.body as { downloadUrl: string }).downloadUrl;
    expect((await app.request(dl, { headers: { cookie: other.cookie, host: "localhost" } })).status).toBe(404);
    const realNow = deps.now;
    deps.now = () => new Date(realNow().getTime() + 3 * 3600_000);
    expect((await c.get(`/api/tools/jobs/${token}`)).status).toBe(404);
    expect((await app.request(dl, { headers: { cookie: c.cookie, host: "localhost" } })).status).toBe(404);
    deps.now = realNow;
  });

  it("says the engine is warming up (503) when it cannot be reached, and counts nothing", async () => {
    const { c, app, db, engine, orgId } = await setup();
    engine.setDown(true);
    const r = await upload(app, c.cookie, "compress", [{ name: "a.pdf", body: PDF }]);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain("warming up");
    expect(await db.all(sql`select * from tool_usage where org_id = ${orgId}`)).toHaveLength(0);
  });
});
