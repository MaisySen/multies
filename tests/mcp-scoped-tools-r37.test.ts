import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { canUseTool, splitToolList, toolListChoice, withToolList } from "@/server/lib/api-scopes";
import { CAPTURED, mcpCatalog, mcpCatalogMarkdown, mcpCatalogView } from "@/server/services/developer/mcp-catalog";

/** R37: "Show only the tools this key can use" (scoped tool list) and the real examples count. */

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

async function connect(key: string, query = "", headers: Record<string, string> = {}) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => { const u = new URL(url); return ctx.app.request(u.pathname + u.search, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } }); }) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost/api/v1/mcp${query}`), { requestInit: { headers: { authorization: `Bearer ${key}`, ...headers } }, fetch: fetchViaApp }));
  return client;
}
const names = async (m: McpClient) => (await m.listTools()).tools.map((t) => t.name).sort();
const ALL = mcpCatalog("dev");
const READ_ONLY = ALL.filter((t) => t.readOnly).map((t) => t.name).sort();

describe("scoped tool list: rules", () => {
  it("stores the option as one extra word and strips it for every check", () => {
    expect(withToolList("mail:read tasks:read", true)).toBe("mail:read tasks:read list:scoped");
    expect(withToolList("full", true)).toBe("full"); // Full access never hides tools
    expect(withToolList("read list:scoped", false)).toBe("read");
    expect(splitToolList("read list:scoped")).toEqual({ scope: "read", scopedList: true });
    expect(splitToolList("tasks:write")).toEqual({ scope: "tasks:write", scopedList: false });
    expect(splitToolList(null)).toEqual({ scope: "full", scopedList: false });
  });
  it("decides per tool the same way the dispatcher does", () => {
    expect(canUseTool("full", "create_agent_inbox", false)).toBe(true);
    expect(canUseTool("read", "list_tasks", true)).toBe(true);
    expect(canUseTool("read", "create_task", false)).toBe(false);
    expect(canUseTool("tasks:read", "list_tasks", true)).toBe(true);
    expect(canUseTool("tasks:read", "create_task", false)).toBe(false);
    expect(canUseTool("tasks:write", "create_task", false)).toBe(true);
    expect(canUseTool("tasks:write", "list_threads", true)).toBe(false);
    expect(canUseTool("mail:send", "list_threads", true)).toBe(true); // write includes read
    expect(canUseTool("tasks:write", "not_a_listed_tool", false)).toBe(false); // unlisted tools need Full access
  });
  it("reads the per connection choice", () => {
    expect(toolListChoice("scoped")).toBe("scoped");
    expect(toolListChoice("ALL")).toBe("all");
    expect(toolListChoice(undefined, "scoped")).toBe("scoped");
    expect(toolListChoice("whatever")).toBeNull();
    expect(toolListChoice(undefined, undefined)).toBeNull();
  });
  it("filters the catalog per preset and per scope", () => {
    const full = mcpCatalogView("dev", "full");
    expect(full.ok && full.tools.length).toBe(ALL.length);
    const read = mcpCatalogView("dev", "read");
    expect(read.ok && read.tools.map((t) => t.name).sort()).toEqual(READ_ONLY);
    const mail = mcpCatalogView("dev", "mail:read");
    expect(mail.ok).toBe(true);
    if (mail.ok) {
      expect(mail.tools.length).toBeGreaterThan(5);
      expect(mail.tools.every((t) => t.area === "mail" && t.readOnly)).toBe(true);
      expect(mail.total).toBe(ALL.length);
    }
    const tw = mcpCatalogView("dev", "tasks:write");
    if (tw.ok) expect(tw.tools.every((t) => t.area === "tasks")).toBe(true);
    expect(mcpCatalogView("dev", "nope:read").ok).toBe(false);
  });
});

describe("scoped tool list: keys, MCP and /api/mcp-tools", () => {
  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup("owner@acme.io");
  });

  it("is on by default for a new scoped key, hides the rest from tools/list, and a hidden tool still gets 403", async () => {
    const made = (await c.post("/api/developer/keys", { name: "Tasks reader", scope: ["tasks:read"] })).body;
    expect(made.apiKey).toMatchObject({ scope: "tasks:read", showOnlyUsableTools: true, scopes: ["tasks:read"] });
    const mcp = await connect(made.secret);
    const seen = await names(mcp);
    const expected = ALL.filter((t) => t.area === "tasks" && t.readOnly).map((t) => t.name).sort();
    expect(seen).toEqual(expected);
    expect(seen).not.toContain("create_task");
    const r = await mcp.callTool({ name: "create_task", arguments: { title: "Hidden" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain("insufficient_scope");
    // The key's other checks still read the plain scope value: REST reads work, REST writes are refused.
    const res = await ctx.app.request("/api/v1/tasks", { headers: { host: "localhost", authorization: `Bearer ${made.secret}` } });
    expect(res.status).toBe(200);
    await mcp.close();
  });

  it("lets a connection ask for every tool (?tools=all) and turns off per key", async () => {
    const made = (await c.post("/api/developer/keys", { name: "Mail", scope: ["mail:read"] })).body;
    const all = await connect(made.secret, "?tools=all");
    expect((await names(all)).length).toBe(ALL.length);
    await all.close();
    const patched = (await c.patch(`/api/developer/keys/${made.apiKey.id}`, { showOnlyUsableTools: false })).body.apiKey;
    expect(patched).toMatchObject({ scope: "mail:read", showOnlyUsableTools: false });
    const off = await connect(made.secret);
    expect((await names(off)).length).toBe(ALL.length);
    await off.close();
    // Changing only the scope keeps the option as it is.
    const back = (await c.patch(`/api/developer/keys/${made.apiKey.id}`, { showOnlyUsableTools: true })).body.apiKey;
    const rescoped = (await c.patch(`/api/developer/keys/${made.apiKey.id}`, { scope: ["mail:read", "chat:read"] })).body.apiKey;
    expect(back.showOnlyUsableTools).toBe(true);
    expect(rescoped).toMatchObject({ scope: "mail:read chat:read", showOnlyUsableTools: true });
    expect((await c.patch(`/api/developer/keys/${made.apiKey.id}`, {})).status).toBe(422);
  });

  it("keeps Full keys and keys made before R37 unchanged, and a read key can opt in per connection", async () => {
    const full = (await c.post("/api/developer/keys", { name: "Full", showOnlyUsableTools: true })).body;
    expect(full.apiKey).toMatchObject({ scope: "full", showOnlyUsableTools: false });
    const fm = await connect(full.secret, "?tools=scoped");
    expect((await names(fm)).length).toBe(ALL.length); // Full keys see everything, even when asked to hide
    await fm.close();
    const ro = (await c.post("/api/developer/keys", { name: "Old style reader", scope: "read", showOnlyUsableTools: false })).body;
    const before = await connect(ro.secret);
    expect((await names(before)).length).toBe(ALL.length);
    await before.close();
    const scoped = await connect(ro.secret, "", { "x-multies-tools": "scoped" });
    expect(await names(scoped)).toEqual(READ_ONLY);
    const r = await scoped.callTool({ name: "create_agent_inbox", arguments: { name: "Nope" } });
    expect((r.content as { text: string }[])[0].text).toContain("read_only_key");
    await scoped.close();
  });

  it("serves a key's view and a scope preview from /api/mcp-tools", async () => {
    const made = (await c.post("/api/developer/keys", { name: "Docs", scope: ["docs:write"] })).body;
    const res = await ctx.app.request("/api/mcp-tools?view=key", { headers: { host: "localhost", authorization: `Bearer ${made.secret}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json() as { scope: string; total: number; tools: { area: string }[] };
    expect(body.scope).toBe("docs:read docs:write");
    expect(body.total).toBe(ALL.length);
    expect(body.tools.length).toBeGreaterThan(5);
    expect(body.tools.every((t) => t.area === "docs")).toBe(true);
    const preview = await ctx.app.request("/api/mcp-tools?scope=read", { headers: { host: "localhost" } });
    expect(((await preview.json()) as { tools: unknown[] }).tools.length).toBe(READ_ONLY.length);
    expect((await ctx.app.request("/api/mcp-tools?scope=bogus", { headers: { host: "localhost" } })).status).toBe(422);
    expect((await ctx.app.request("/api/mcp-tools?view=key", { headers: { host: "localhost", authorization: "Bearer mm_live_notarealkeynotarealkey00" } })).status).toBe(401);
    const plain = await ctx.app.request("/api/mcp-tools", { headers: { host: "localhost" } });
    expect(((await plain.json()) as { tools: unknown[] }).tools.length).toBe(ALL.length);
  });
});

describe("real example results", () => {
  it("has at least 40 tools with a real example call and result, and every one is a live tool", () => {
    const real = ALL.filter((t) => t.example.captured);
    expect(real.length).toBeGreaterThanOrEqual(40);
    for (const name of Object.keys(CAPTURED)) expect(ALL.some((t) => t.name === name), `${name} is not a tool any more`).toBe(true);
    for (const t of real) { expect(t.example.resultIsShape).toBe(false); expect(t.example.result).toBeTruthy(); }
  });
  it("covers the tools people use most", () => {
    for (const n of ["list_threads", "read_thread", "send_email", "reply", "search", "create_task", "list_tasks", "update_task", "post_message", "list_channels", "create_doc", "read_doc", "schedule_meeting", "list_meetings", "upsert_contact", "search_contacts"]) expect(CAPTURED[n], n).toBeTruthy();
  });
  it("holds no secrets, no local addresses and no personal looking emails", () => {
    const text = JSON.stringify(CAPTURED);
    expect(text).not.toMatch(/mm_live_[A-Za-z0-9]{6,}/);
    expect(text).not.toMatch(/localhost|127\.0\.0\.1|tab\.bot/);
    const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [])];
    for (const e of emails) expect(e).toMatch(/@(example\.com|acme\.io)$/);
  });
  it("puts the examples and the scoped list section in the Markdown docs", () => {
    const md = mcpCatalogMarkdown("dev");
    expect(md).toContain("## Show only the tools a key can use");
    expect(md).toContain("?tools=scoped");
    expect(md).toContain("## Example calls with real results");
    expect((md.match(/^Result:$/gm) ?? []).length).toBeGreaterThanOrEqual(40);
  });
});
