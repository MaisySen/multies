/**
 * R66 (Tools fixes from QA pass 5): runs left shows the tighter of the day and the month (MB-255), only finished
 * runs with a result are counted (MB-256), Cancel stops the job on the engine (MB-257), a run survives a refresh,
 * Back or a dropped connection (MB-258, MB-260), held features are a plain not found page (MB-259), and the
 * smaller fixes (drop any file, search, suffixes, stamp defaults).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { chargeJob, pruneToolUsage } from "@/server/services/tools/usage";
import { emptyResult, resultName, toolDef, type ToolDef } from "@/shared/tools";
import { buildEntries, entryTakes, noRunsLine, resetWhen, runsLeft, runsLeftLabel, searchEntries } from "@/web/components/tools/tool-directory";
import { defaultsFor, optionsProblem } from "@/web/components/tools/tool-fields";
import { clearRun, isOfflineError, saveRun, savedRun, savedRuns } from "@/web/lib/tool-jobs";
import { carryFiles, peekCarried, takeCarried } from "@/web/lib/carried-files";
import { TOOLS } from "@/shared/tools";
import { TOOL_FEATURES } from "@/shared/tool-features";

const ENGINE_KEY = "k".repeat(40);
const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: ENGINE_KEY, TOOLS_TOKEN_KEY: "t".repeat(40), TOOLS_FEATURES: "all" };
const PDF = "%PDF-1.4\n% fake pdf for tests\n";

interface FakeJob { id: string; ws: string; op: string; status: string; result?: Record<string, number>; error?: string }

/** A fake engine that checks signatures, answers each job with the status the test sets, and deletes on DELETE. */
function fakeEngine() {
  const jobs = new Map<string, FakeJob>();
  const deleted: string[] = [];
  let next: Partial<FakeJob> = { status: "done" };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    const pathQs = url.pathname + url.search;
    if (init?.body) await new Response(init.body as BodyInit).arrayBuffer();
    const len = h.get("content-length") ?? "0";
    const want = createHmac("sha256", ENGINE_KEY).update(["v1", method, pathQs, h.get("x-multies-ts"), h.get("x-multies-nonce"), h.get("x-multies-ws"), h.get("x-multies-user"), h.get("x-multies-max-bytes"), len].join("\n")).digest("hex");
    if (h.get("x-multies-sig") !== want) return Response.json({ error: "unauthorized" }, { status: 401 });
    const ws = h.get("x-multies-ws")!;
    if (method === "POST" && url.pathname === "/internal/v1/jobs") {
      const id = Math.random().toString(16).slice(2).padEnd(16, "a") + "beef";
      jobs.set(id, { id, ws, op: url.searchParams.get("op")!, status: "done", ...next });
      return Response.json({ id, status: "queued" }, { status: 202 });
    }
    const m = url.pathname.match(/^\/internal\/v1\/jobs\/([a-f0-9]+)(\/output)?$/);
    const job = m ? jobs.get(m[1]) : undefined;
    if (!job || job.ws !== ws) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "DELETE") { jobs.delete(job.id); deleted.push(job.id); return new Response(null, { status: 204 }); }
    if (m![2]) return new Response(PDF, { headers: { "content-type": "application/pdf" } });
    return Response.json({ id: job.id, status: job.status, error: job.error, result: job.result, output: job.status === "done" ? { bytes: PDF.length, content_type: "application/pdf" } : undefined });
  };
  return { fetch: fetch as typeof globalThis.fetch, jobs, deleted, setNext: (j: Partial<FakeJob>) => { next = j; } };
}

async function setup() {
  const engine = fakeEngine();
  const ctx = await makeTestApp(ON, { fetch: engine.fetch });
  const c = new Client(ctx.app);
  await c.signup(undefined, "Ada Lovelace", "Acme");
  const upload = async (op: string, name = "a.pdf") => {
    const fd = new FormData();
    fd.append("files", new Blob([PDF], { type: "application/pdf" }), name);
    const req = new Request("http://localhost/x", { method: "POST", body: fd });
    const bytes = new Uint8Array(await req.arrayBuffer());
    const res = await ctx.app.request(`/api/tools/jobs?op=${op}&files=1&name=${name}`, { method: "POST", body: bytes, headers: { cookie: c.cookie, host: "localhost", "content-type": req.headers.get("content-type")!, "content-length": String(bytes.byteLength), "x-multies-upload": "1" } });
    return (await res.json()) as { token: string };
  };
  const runs = async () => Number((await ctx.db.get<{ n: number | null }>(sql`select sum(runs) as n from tool_usage where length(period) = 10`))?.n ?? 0);
  return { ...ctx, c, engine, upload, runs };
}

describe("R66 MB-255: runs left", () => {
  const limits = { runsMonthly: 100, runsDaily: 30 };
  const now = new Date("2026-10-30T10:16:00Z");
  it("shows the tighter of today and this month, and when it comes back in the workspace's time", () => {
    const day = runsLeft({ month: 26, day: 18 }, limits, now);
    expect(day).toMatchObject({ left: 12, per: "day" });
    expect(runsLeftLabel(day)).toBe("12 runs left today");
    expect(day.resetsAt.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(resetWhen(day, "Australia/Sydney", now)).toBe("at 11 am tomorrow");
    const month = runsLeft({ month: 99, day: 2 }, limits, now);
    expect(runsLeftLabel(month)).toBe("1 run left this month");
    expect(resetWhen(month, "Australia/Sydney", now)).toBe("on Sun 1 Nov at 11 am");
    const none = runsLeft({ month: 30, day: 30 }, limits, now);
    expect(runsLeftLabel(none)).toBe("No runs left today");
    expect(noRunsLine(none, "Australia/Sydney", now)).toBe("You have used today's 30 runs. More at 11 am tomorrow.");
    expect(resetWhen(none, "Not/AZone", now)).toBe("at 12 am tomorrow");
  });
  it("disables Run and says why on the tool screen, on phones too", () => {
    const src = readFileSync("src/web/pages/app/tools.tsx", "utf8");
    expect(src).toContain("&& !noneLeft");
    expect(src).toContain('data-testid="tools-none-left"');
    expect(src).toContain('{usage && <div className="mt-2 sm:hidden">{usage}</div>}');
  });
});

describe("R66 MB-256: only finished runs with a result are counted", () => {
  it("counts a done job once, however many times its status is read", async () => {
    const { c, upload, runs } = await setup();
    const j = await upload("compress");
    expect(await runs()).toBe(0);
    expect((await c.get(`/api/tools/jobs/${j.token}`)).body).toMatchObject({ status: "done" });
    await c.get(`/api/tools/jobs/${j.token}`);
    expect(await runs()).toBe(1);
  });
  it("does not count a failed run or one that found nothing", async () => {
    const { c, upload, runs, engine } = await setup();
    engine.setNext({ status: "failed", error: "Pick a stamp." });
    const f = await upload("stamp");
    expect((await c.get(`/api/tools/jobs/${f.token}`)).body).toMatchObject({ status: "failed" });
    engine.setNext({ status: "done", result: { tables: 0 } });
    const e = await upload("pdf-tables");
    expect((await c.get(`/api/tools/jobs/${e.token}`)).body).toMatchObject({ status: "done", notCounted: true });
    engine.setNext({ status: "done", result: { matches: 0 } });
    const r = await upload("redact");
    expect((await c.get(`/api/tools/jobs/${r.token}`)).body).toMatchObject({ notCounted: true });
    // R71 (MB-263): nothing found by Find sensitive info, and a compress that gave the file back, are not counted.
    engine.setNext({ status: "done", result: { matches: 0 } });
    const p = await upload("pii-find");
    expect((await c.get(`/api/tools/jobs/${p.token}`)).body).toMatchObject({ notCounted: true });
    engine.setNext({ status: "done", result: { in_bytes: 963_000, out_bytes: 962_000 } });
    const z = await upload("compress");
    expect((await c.get(`/api/tools/jobs/${z.token}`)).body).toMatchObject({ notCounted: true, result: { in_bytes: 963_000, out_bytes: 962_000 } });
    expect(await runs()).toBe(0);
    engine.setNext({ status: "done", result: { in_bytes: 963_000, out_bytes: 276_000 } });
    const k = await upload("compress");
    expect((await c.get(`/api/tools/jobs/${k.token}`)).body).not.toHaveProperty("notCounted");
    expect(await runs()).toBe(1);
  });
  it("marks each counted job once and prunes the marks with the day rows", async () => {
    const { db } = await setup();
    const now = new Date();
    expect(await chargeJob(db, "org_x", "a".repeat(32), now, 10)).toBe(true);
    expect(await chargeJob(db, "org_x", "a".repeat(32), now, 10)).toBe(false);
    await pruneToolUsage(db, new Date(now.getTime() + 3 * 86_400_000));
    expect((await db.all(sql`select job_id from tool_job_charges`)).length).toBe(0);
  });
  it("knows an empty result", () => {
    expect(emptyResult("pdf-tables", { tables: 0 })).toBe(true);
    expect(emptyResult("pdf-tables", { tables: 2 })).toBe(false);
    expect(emptyResult("redact", { matches: 0 })).toBe(true);
    expect(emptyResult("compress", {})).toBe(false);
    expect(emptyResult("redact", undefined)).toBe(false);
  });
  it("Stamp starts with page numbers, never offers a Run that can only fail, and has one name", () => {
    const stamp = toolDef("stamp");
    const d = defaultsFor(stamp);
    expect(d.page_numbers).toBe("page n of N");
    expect(optionsProblem(stamp, d)).toBeNull();
    expect(optionsProblem(stamp, { ...d, page_numbers: "none" })).toBe("Pick a stamp, page numbers, a header or a footer.");
    expect(optionsProblem(stamp, { ...d, page_numbers: "none", stamp: "custom", stamp_text: "" })).toBe("Type the stamp words.");
    const e = buildEntries(TOOLS as unknown as ToolDef[], [...TOOL_FEATURES]).find((x) => x.key === "stamp");
    expect(e?.name).toBe(stamp.label);
  });
});

describe("R66 MB-257: Cancel stops the job on the server", () => {
  it("deletes the engine job, frees its place and counts nothing; other workspaces cannot cancel it", async () => {
    const { c, upload, runs, engine, app } = await setup();
    engine.setNext({ status: "running" });
    const j = await upload("compress");
    const other = new Client(app);
    await other.signup(undefined, "Eve", "Other Co");
    expect((await other.del(`/api/tools/jobs/${j.token}`)).status).toBe(404);
    const r = await c.del(`/api/tools/jobs/${j.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "cancelled" });
    expect(engine.deleted).toHaveLength(1);
    expect(engine.jobs.size).toBe(0);
    expect((await c.get(`/api/tools/jobs/${j.token}`)).body).toMatchObject({ status: "expired" });
    expect((await c.del(`/api/tools/jobs/${j.token}`)).status).toBe(200); // already gone is fine
    expect(await runs()).toBe(0);
  });
});

describe("R66 MB-258 and MB-260: a run survives refresh, Back and a dropped connection", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    (globalThis as { sessionStorage?: Storage }).sessionStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); },
      key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; }, clear: () => m.clear(),
    } as Storage;
  });
  it("keeps the job per tool for two hours, newest first", () => {
    const now = Date.now();
    saveRun({ op: "compress", token: "tok1", name: "a-compressed.pdf", at: now - 1000, before: 2000 });
    saveRun({ op: "merge", token: "tok2", name: "a-merged.pdf", at: now });
    expect(savedRun("compress")).toMatchObject({ token: "tok1", before: 2000 });
    expect(savedRuns().map((r) => r.op)).toEqual(["merge", "compress"]);
    expect(savedRun("compress", now + 2 * 3600_000 + 1)).toBeNull();
    clearRun("merge");
    expect(savedRuns()).toEqual([]);
  });
  it("tells a dropped connection from a real error", () => {
    expect(isOfflineError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isOfflineError(Object.assign(new Error("x"), { status: 0 }))).toBe(true);
    expect(isOfflineError(Object.assign(new Error("x"), { status: 422 }))).toBe(false);
  });
  it("resumes a kept run on the tool screen and retries when back online", () => {
    const src = readFileSync("src/web/pages/app/tools.tsx", "utf8");
    expect(src).toContain("const kept = tool ? savedRun(tool.op) : null;");
    expect(src).toContain('window.addEventListener("online", back)');
    expect(src).toContain('window.addEventListener("online", again)');
    expect(src).toContain("void cancelJob(phase.job.token)");
  });
});

describe("R66 MB-259: held features are a plain not found page", () => {
  it("gates every feature page in the router and keeps /sign off the Worker while e-sign is off", () => {
    const router = readFileSync("src/web/router.tsx", "utf8");
    for (const f of ['features={["merge_mail"]}', 'features={["esign"]}', "features={AI_FEATURES}", 'features={["folders", "index"]}']) expect(router).toContain(f);
    const gate = readFileSync("src/web/components/tools/feature-gate.tsx", "utf8");
    expect(gate).toContain("<NotFound embedded />"); // R67: one main landmark inside the app layout
    expect(gate.slice(gate.indexOf("export function"))).not.toMatch(/admin|legal|signature/i);
    expect(readFileSync("src/entry/worker.ts", "utf8")).toContain('(url.pathname.startsWith("/sign/") && await esignOn(env))');
    expect(readFileSync("src/web/pages/app/ai-section.tsx", "utf8")).toMatch(/useAiUsage\(!!config\.data\?\.tools && \["ask"/);
  });
});

describe("R66 minors", () => {
  const entries = buildEntries(TOOLS as unknown as ToolDef[], [...TOOL_FEATURES]);
  it("drop any file offers the pages and multi file tools that take it", () => {
    const keys = entries.filter((e) => entryTakes(e, "Lease.pdf", true)).map((e) => e.key);
    for (const k of ["organize", "form-fill", "compare", "merge", "share", "compress"]) expect(keys).toContain(k);
    expect(keys).not.toContain("ask");
    // A mail attachment still lists only what runs on one file there.
    expect(entries.filter((e) => entryTakes(e, "Lease.pdf")).map((e) => e.key)).not.toContain("merge");
  });
  it("search matches whole word starts and skips small words", () => {
    const ai = searchEntries(entries, "ai").map((e) => e.key);
    expect(ai.every((k) => ["ask", "translate", "extract", "expenses", "contracts"].includes(k))).toBe(true);
    expect(searchEntries(entries, "pdf to word").map((e) => e.key)).not.toContain("protect");
    expect(searchEntries(entries, "pdf to word")[0].key).toBe("pdf-to-docx");
    expect(searchEntries(entries, "compr").map((e) => e.key)).toContain("compress");
  });
  it("does not stack suffixes when a tool runs on its own result", () => {
    expect(resultName("compress", "invoice-compressed.pdf")).toBe("invoice-compressed.pdf");
    expect(resultName("compress", "invoice.pdf")).toBe("invoice-compressed.pdf");
  });
  it("hands a dropped file to the next page once", () => {
    const f = new File(["x"], "a.pdf");
    carryFiles([f]);
    expect(peekCarried()).toEqual([f]);
    expect(takeCarried()).toEqual([f]);
    expect(peekCarried()).toEqual([]);
  });
});
