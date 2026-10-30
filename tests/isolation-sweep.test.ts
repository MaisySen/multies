import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { v1Routes } from "@/server/routes/v1";
import { r10Routes } from "@/server/routes/suite-r10";

// Cross-workspace sweep (round 11 security audit). Workspace A is the seeded demo; workspace B is a
// fresh signup with its own API key. Every route that takes an id is called by B with A's real ids,
// through the session API, the /api/v1 REST API and the MCP server. Nothing may answer 2xx or 5xx:
// another workspace's record is a 404 (or 403), never a read, a write or a crash.

type Route = { method: string; path: string };
const ID = /^[a-z]{2,6}_[a-z0-9]{12,}$/;

/** Every string id in a JSON body, grouped by the key it sat under. */
function collectIds(v: unknown, out: Map<string, Set<string>>, key = "id") {
  if (Array.isArray(v)) { for (const x of v) collectIds(x, out, key); return; }
  if (v && typeof v === "object") { for (const [k, x] of Object.entries(v)) collectIds(x, out, k); return; }
  if (typeof v === "string" && ID.test(v)) {
    const s = out.get(key) ?? new Set<string>();
    s.add(v);
    out.set(key, s);
  }
}


// Long polls and event streams never finish on their own; a read that takes longer is skipped.
async function withTimeout<T extends { status: number; body: unknown }>(p: Promise<T>, label: string): Promise<{ status: number; body: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ status: number; body: unknown }>((resolve) => { timer = setTimeout(() => { if (process.env.SWEEP_DEBUG) console.log("slow", label); resolve({ status: 0, body: null }); }, 2000); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

async function setup() {
  const { app } = await makeTestApp({ DEMO_MODE: "true" });
  const a = new Client(app);
  const b = new Client(app);
  expect((await a.post("/api/account/demo")).status).toBe(201);
  await a.post("/api/account/demo/seed");
  await b.signup("intruder@other.io");
  const bKey = await b.post("/api/developer/keys", { name: "sweep" });
  const aKey = await a.post("/api/developer/keys", { name: "sweep" });
  expect(bKey.status).toBe(201);
  expect(aKey.status).toBe(201);
  const bMe = (await b.get("/api/account/me")).body;
  const own = new Set<string>(JSON.stringify(bMe).match(/[a-z]{2,6}_[a-z0-9]{12,}/g) ?? []);
  const asA = (path: string) => withTimeout(asA0(path), path);
  const asA0 = async (path: string) => {
    if (!path.startsWith("/api/v1/")) return a.get(path);
    const r = await app.request(path, { headers: { authorization: `Bearer ${aKey.body.secret}`, host: "localhost" } });
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) as unknown }; } catch { return { status: r.status, body: null }; }
  };
  const v1: Route[] = v1Routes().routes.map((r) => ({ method: r.method, path: `/api/v1${r.path === "/" ? "" : r.path}` }));
  // Chat, templates, goals and guest chat are built on first use, so their routes are listed from r10Routes().
  const r10 = r10Routes(new WeakMap()).routes.map((r) => ({ method: r.method, path: r.path }));
  const routes: Route[] = [...app.routes, ...r10].filter((r) => r.method !== "ALL" && r.path.startsWith("/api/")).concat(v1);
  // A's ids, keyed by the path segment of the list they came from ("tasks", "channels", ...).
  const bySeg = new Map<string, string[]>();
  const all: string[] = [];
  const keep = (seg: string, body: unknown) => {
    const found = new Map<string, Set<string>>();
    collectIds(body, found);
    const ids = [...(found.get("id") ?? [])].filter((x) => !own.has(x));
    if (ids.length && !bySeg.has(seg)) bySeg.set(seg, ids);
    for (const set of found.values()) for (const x of set) if (!own.has(x)) all.push(x);
  };
  const lastSeg = (path: string) => path.split("/").filter((x) => x && !x.startsWith(":")).pop() ?? "";
  for (const r of routes) {
    if (r.method !== "GET" || r.path.includes(":") || r.path.includes("*") || r.path.endsWith("/mcp")) continue;
    const res = await asA(r.path);
    if (res.status === 200) keep(lastSeg(r.path), res.body);
  }
  // One level deeper: nested lists such as /chat/channels/:id/messages.
  for (const r of routes) {
    if (r.method !== "GET") continue;
    const params = r.path.split("/").filter((x) => x.startsWith(":"));
    if (params.length !== 1 || r.path.endsWith(params[0])) continue;
    const segs = r.path.split("/");
    const parent = segs[segs.indexOf(params[0]) - 1];
    const id = bySeg.get(parent)?.[0];
    if (!id) continue;
    const res = await asA(r.path.replace(params[0], id).replace(/\{[^}]*\}/g, ""));
    if (res.status === 200) keep(lastSeg(r.path), res.body);
  }
  return { app, a, b, apiKey: bKey.body.secret as string, bySeg, all, routes };
}

const STEMS: Record<string, string> = { blockedBy: "tasks", threadId: "threads", keyId: "keys", messageId: "messages", channelId: "channels", taskId: "tasks", projectId: "projects", agentId: "agents", mailboxId: "mailboxes", docId: "docs", goalId: "goals" };

/** One of A's ids for a path parameter: from the list named by the segment before it, else any of A's ids. */
function pick(path: string, param: string, bySeg: Map<string, string[]>, all: string[]): string | undefined {
  const segs = path.split("/");
  const before = segs[segs.indexOf(param) - 1] ?? "";
  const named = STEMS[param.slice(1)];
  return (named && bySeg.get(named)?.[0]) ?? bySeg.get(before)?.[0] ?? (param === ":id" || /Id$/.test(param) ? all[0] : undefined);
}

describe("cross-workspace isolation sweep", () => {
  it("answers 404 or 403 when another workspace's ids are used on the app API, the REST API and MCP", async () => {
    const { app, b, apiKey, bySeg, all, routes } = await setup();
        expect(bySeg.size).toBeGreaterThanOrEqual(15);
    if (process.env.SWEEP_DEBUG) console.log("segments", [...bySeg.keys()].join(" "));
    const leaks: string[] = [];
    let tried = 0;
    for (const r of routes) {
      if (!r.path.includes(":") || r.method === "ALL") continue;
      if (/\/api\/(auth|webhooks|inbound|import-runner|guest)\b/.test(r.path) || r.path.startsWith("/api/v1/mcp")) continue;
      const params = r.path.split("/").filter((s) => s.startsWith(":"));
      const vals = params.map((p) => pick(r.path, p, bySeg, all));
      if (vals.some((v) => !v)) { if (process.env.SWEEP_DEBUG) console.log("skip", r.method, r.path); continue; }
      let path = r.path;
      params.forEach((p, i) => { path = path.replace(p, vals[i]!); });
      path = path.replace(/\{[^}]*\}/g, "");
      const isV1 = path.startsWith("/api/v1/");
      const headers: Record<string, string> = isV1 ? { authorization: `Bearer ${apiKey}` } : {};
      const body = ["GET", "HEAD", "DELETE"].includes(r.method) ? undefined : { name: "x", title: "x", text: "x", body: "x" };
      const res = await withTimeout(isV1
        ? Promise.resolve(app.request(path, { method: r.method, headers: { ...headers, host: "localhost", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined })).then((x) => ({ status: x.status, body: null }))
        : b.call(r.method, path, body), `${r.method} ${path}`);
      tried++;
      if (res.status === 0) continue;
      if (res.status < 400 || res.status >= 500) leaks.push(`${res.status} ${r.method} ${r.path}`);
    }
    console.log(`isolation sweep: ${tried} id routes tried`);
    expect(tried).toBeGreaterThan(150);
    expect(leaks).toEqual([]);

    // MCP: every tool argument that names an id gets one of A's ids. A refusal passes, and so does an
    // answer that carries none of A's records (an empty list for a foreign filter).
    const mcp = new McpClient({ name: "sweep", version: "1" });
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } }, fetch: fetchViaApp }));
    const tools = (await mcp.listTools()).tools;
    const mcpLeaks: string[] = [];
    let mcpTried = 0;
    for (const t of tools) {
      const props = (t.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {};
      const idArgs = Object.keys(props).filter((k) => /Id$|^id$/.test(k));
      if (!idArgs.length) continue;
      const args: Record<string, unknown> = { text: "x", subject: "x", to: ["x@example.com"], name: "x", title: "x" };
      let ok = true;
      for (const k of idArgs) { const v = pick(`/x/:${k}`, `:${k}`, bySeg, all); if (!v) ok = false; else args[k] = v; }
      if (!ok) continue;
      for (const k of Object.keys(args)) if (!(k in props)) delete args[k];
      mcpTried++;
      const out = await mcp.callTool({ name: t.name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      if (process.env.SWEEP_DEBUG) console.log("mcp", t.name, out.isError ? "refused" : "ANSWERED", JSON.stringify(args), out.isError ? "" : JSON.stringify(out.content).slice(0, 400));
      // A filter with a foreign id may answer an empty list; any of A's ids in the answer is a leak.
      const text = JSON.stringify(out.content ?? "");
      if (!out.isError && all.some((id) => text.includes(id))) mcpLeaks.push(`${t.name} ${JSON.stringify(args)}`);
    }
    await mcp.close();
    console.log(`isolation sweep: ${mcpTried} MCP tools tried`);
    expect(mcpLeaks).toEqual([]);
  }, 300_000);
});
