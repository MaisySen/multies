import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { buildMcpServer } from "@/server/routes/mcp-server";
import { v1Routes } from "@/server/routes/v1";
import { ALL_SCOPES, grantedScopes, hasScope, listedTools, normalizeScopes, routeScope, scopeChips, toolScope } from "@/server/lib/api-scopes";

/** R36: per area API key scopes. */
describe("scope map", () => {
  it("gives every MCP tool a scope, and lists no tool that is gone", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = buildMcpServer({ config: { release: "t" } } as any, { orgId: "o", userId: "u", role: "admin", scope: "full", agentId: null } as any, "https://multies.si") as any;
    const tools = Object.entries(s._registeredTools) as [string, { annotations?: { readOnlyHint?: boolean } }][];
    expect(tools.length).toBeGreaterThan(150);
    const missing = tools.filter(([n, t]) => toolScope(n, !!t.annotations?.readOnlyHint) === "full").map(([n]) => n);
    expect(missing).toEqual([]);
    const stale = listedTools().filter((n) => !s._registeredTools[n]);
    expect(stale).toEqual([]);
    expect(toolScope("list_tasks", true)).toBe("tasks:read");
    expect(toolScope("create_task", false)).toBe("tasks:write");
    expect(toolScope("send_email", false)).toBe("mail:send");
  });

  it("gives every /api/v1 route a scope", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = v1Routes() as any;
    const unmapped = (api.routes as { method: string; path: string }[])
      .filter((r) => r.method !== "ALL" && !r.path.includes("*"))
      .filter((r) => routeScope(r.method, r.path, r.path) === "full")
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(unmapped)]).toEqual([]);
    expect(routeScope("GET", "/tasks/abc")).toBe("tasks:read");
    expect(routeScope("POST", "/tasks")).toBe("tasks:write");
    expect(routeScope("POST", "/agents", "/agents")).toBe("admin:write");
    expect(routeScope("POST", "/snippets/s1/render")).toBe("mail:read");
    expect(routeScope("GET", "/openapi.json")).toBeNull();
  });

  it("keeps the presets and normalises lists", () => {
    expect(grantedScopes("full").size).toBe(ALL_SCOPES.length);
    expect(hasScope("read", "tasks:read")).toBe(true);
    expect(hasScope("read", "tasks:write")).toBe(false);
    expect(hasScope("tasks:write", "tasks:read")).toBe(true);
    expect(hasScope("tasks:read", "mail:read")).toBe(false);
    expect(normalizeScopes([...ALL_SCOPES])).toEqual({ ok: true, value: "full" });
    expect(normalizeScopes(ALL_SCOPES.filter((s) => s.endsWith(":read")))).toEqual({ ok: true, value: "read" });
    expect(normalizeScopes(["tasks:write"])).toEqual({ ok: true, value: "tasks:read tasks:write" });
    expect(normalizeScopes(["tasks:everything"])).toEqual({ ok: false, unknown: ["tasks:everything"] });
    expect(scopeChips("full")).toEqual(["Full access"]);
    expect(scopeChips("mail:read tasks:read tasks:write")).toEqual(["Mail: read", "Tasks and projects: create and change"]);
  });
});

describe("scoped keys", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup("owner@acme.io");
  });
  const v1 = (key: string, method: string, path: string, body?: unknown) =>
    ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

  it("lists the scopes and presets for the create sheet", async () => {
    const r = await c.get("/api/developer/scopes");
    expect(r.status).toBe(200);
    expect(r.body.areas.map((a: { area: string }) => a.area)).toContain("tasks");
    expect(r.body.presets.map((p: { id: string }) => p.id)).toEqual(["full", "read"]);
  });

  it("answers 403 insufficient_scope without the scope and works once it is added", async () => {
    const made = await c.post("/api/developer/keys", { name: "Reader", scope: ["tasks:read"] });
    expect(made.status).toBe(201);
    expect(made.body.apiKey.scope).toBe("tasks:read");
    expect(made.body.apiKey.scopeChips).toEqual(["Tasks and projects: read"]);
    const key = made.body.secret as string;
    expect((await v1(key, "GET", "/tasks")).status).toBe(200);
    const denied = await v1(key, "POST", "/projects", { name: "Launch" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "insufficient_scope", required: "tasks:write" } });
    const admin = await v1(key, "GET", "/domains");
    expect(admin.status).toBe(403);
    expect((await admin.json()).error.required).toBe("admin:read");

    const edited = await c.call("PATCH", `/api/developer/keys/${made.body.apiKey.id}`, { scope: ["tasks:write"] });
    expect(edited.status).toBe(200);
    expect(edited.body.apiKey.scope).toBe("tasks:read tasks:write");
    expect((await v1(key, "POST", "/projects", { name: "Launch" })).status).toBeLessThan(300);
  });

  it("refuses unknown scope names", async () => {
    const r = await c.post("/api/developer/keys", { name: "Bad", scope: ["tasks:all"] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("invalid_scope");
  });

  it("keeps preset keys exactly as before", async () => {
    const full = (await c.post("/api/developer/keys", { name: "Full" })).body;
    expect(full.apiKey.scope).toBe("full");
    expect((await v1(full.secret, "GET", "/domains")).status).toBe(200);
    const ro = (await c.post("/api/developer/keys", { name: "RO", scope: "read" })).body;
    const r = await v1(ro.secret, "POST", "/projects", { name: "X" });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("read_only_key");
  });

  it("checks each MCP tool against the key's scopes", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Agent", scope: ["tasks:read", "chat:read"] })).body.secret as string;
    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const ok = await mcp.callTool({ name: "list_projects", arguments: {} });
    expect(ok.isError).toBeFalsy();
    const no = await mcp.callTool({ name: "create_task", arguments: { title: "x" } });
    expect(no.isError).toBe(true);
    expect((no.content as { text: string }[])[0].text).toMatch(/^insufficient_scope: .*tasks:write/);
    const mail = await mcp.callTool({ name: "list_threads", arguments: {} });
    expect((mail.content as { text: string }[])[0].text).toMatch(/mail:read/);
  });
});
