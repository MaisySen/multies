import { TOOL_FEATURES } from "@/shared/tool-features";
import { describe, it, expect } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { loadConfig } from "@/server/config";
import { flagOn } from "@/web/lib/commands/registry";
import { navCommands } from "@/web/lib/commands/modules/nav";
import { PALETTE_PAGES } from "@/web/lib/palette-registry";
import { SETTINGS_GROUPS, panesFor } from "@/web/pages/app/settings";

/** R59: chat channels (C1) sit behind CHAT_CHANNELS, off unless set. Off: nothing of the feature answers or shows. */
const CHAT_TOOLS = ["add_chat_note", "get_chat_conversation", "list_chat_conversations", "list_chat_templates", "reply_chat", "send_chat_template", "update_chat_conversation"];
const NOT_FOUND = { error: { code: "not_found", message: "No such endpoint." } };

async function setup(env: Record<string, string>) {
  const ctx = await makeTestApp(env);
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  return { ctx, owner };
}

async function mcpTools(ctx: Awaited<ReturnType<typeof makeTestApp>>, owner: Client) {
  const key = (await owner.post("/api/developer/keys", { name: "Agent" })).body.secret as string;
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return (await client.listTools()).tools.map((t) => t.name);
}

describe("CHAT_CHANNELS switch", () => {
  it("is off unless set, on only for on, 1 or true", () => {
    const base = { APP_SECRET: "t".repeat(40) };
    expect(loadConfig(base).channels.enabled).toBe(false);
    expect(loadConfig({ ...base, CHAT_CHANNELS: "off" }).channels.enabled).toBe(false);
    expect(loadConfig({ ...base, CHANNELS_MOCK: "on" }).channels.enabled).toBe(false);
    for (const v of ["on", "1", "true"]) expect(loadConfig({ ...base, CHAT_CHANNELS: v }).channels.enabled).toBe(true);
  });

  it("off: channel routes and the Meta webhook answer the plain 404 and store nothing", async () => {
    const { ctx, owner } = await setup({ CHANNELS_MOCK: "on" });
    for (const path of ["/api/channels/status", "/api/channels/conversations", "/api/channels/nope"]) {
      const r = await owner.get(path);
      expect(r.status, path).toBe(404);
      expect(r.body).toEqual(NOT_FOUND);
    }
    expect((await owner.put("/api/channels/settings", { enabled: true })).status).toBe(404);
    expect((await owner.post("/api/channels/connect-mock", { name: "x" })).status).toBe(404);
    // Signed out too: the gate answers before auth, so the routes look like they do not exist.
    expect((await ctx.app.request("/api/channels/status")).status).toBe(404);
    const verify = await ctx.app.request("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123");
    expect(verify.status).toBe(404);
    expect(await verify.json()).toEqual(NOT_FOUND);
    const post = await ctx.app.request("/api/webhooks/meta", { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" }, body: JSON.stringify({ object: "whatsapp_business_account", entry: [] }) });
    expect(post.status).toBe(404);
    expect((await ctx.app.request("/api/config")).status).toBe(200);
    expect((await (await ctx.app.request("/api/config")).json()).chatChannels).toBe(false);
  });

  it("off: no MCP chat tools are listed", async () => {
    const { ctx, owner } = await setup({});
    const tools = await mcpTools(ctx, owner);
    expect(tools.filter((t) => CHAT_TOOLS.includes(t))).toEqual([]);
    expect(tools).toContain("list_channels"); // team chat stays
    const catalog = (await (await ctx.app.request("/api/mcp-tools")).json()).tools.map((t: { name: string }) => t.name);
    expect(catalog.filter((t: string) => CHAT_TOOLS.includes(t))).toEqual([]);
    expect(await (await ctx.app.request("/developers/mcp.md")).text()).not.toContain("list_chat_conversations");
  });

  it("on: the routes answer, the tools are listed and /api/config says so", async () => {
    const { ctx, owner } = await setup({ CHAT_CHANNELS: "on", CHANNELS_MOCK: "on" });
    expect((await owner.get("/api/channels/status")).status).toBe(200);
    expect((await ctx.app.request("/api/channels/status")).status).toBe(401);
    expect((await (await ctx.app.request("/api/config")).json()).chatChannels).toBe(true);
    const tools = await mcpTools(ctx, owner);
    expect(CHAT_TOOLS.filter((t) => !tools.includes(t))).toEqual([]);
    const catalog = (await (await ctx.app.request("/api/mcp-tools")).json()).tools.map((t: { name: string }) => t.name);
    expect(CHAT_TOOLS.filter((t) => !catalog.includes(t))).toEqual([]);
  });
});

describe("CHAT_CHANNELS in the web app", () => {
  it("hides the Settings pane and the command menu entry while off", () => {
    const panes = SETTINGS_GROUPS.flatMap((g) => g.items);
    const channels = panes.find((p) => p.to === "/app/settings/channels")!;
    expect(channels).toBeTruthy();
    expect(panes.filter(panesFor({ chatChannels: false }))).not.toContain(channels);
    expect(panes.filter(panesFor(undefined))).not.toContain(channels);
    expect(panes.filter(panesFor({ chatChannels: true }))).toContain(channels);
    expect(panes.filter(panesFor({})).length).toBe(panes.length - 2); // R111: Archive and retention is also flag gated
    expect(panes.filter(panesFor({ mailArchive: true })).map((p) => p.to)).toContain("/app/settings/mail-archive");

    expect(PALETTE_PAGES.find((p) => p.id === "p-chat-channels")?.flag).toBe("chatChannels");
    const cmd = navCommands.find((c) => c.to === "/app/settings/channels")!;
    expect(flagOn(cmd, { chatChannels: false })).toBe(false);
    expect(flagOn(cmd, undefined)).toBe(false);
    expect(flagOn(cmd, { chatChannels: true })).toBe(true);
    // Every other page stays in the menu whatever the switch says (Tools has its own switch, Tools P1).
    // Tools P2 entries also need their own feature on (toolFeatures), so they are left out here.
    const base = navCommands.filter((c) => !c.toolFeature);
    expect(base.filter((c) => !flagOn(c, {})).map((c) => c.to)).toEqual(["/app/docs/help-center", "/app/docs/links", "/app/docs/links?save=page", "/app/tools", "/app/tools/convert", "/app/files?view=team", "/app/files?view=brand", "/app/files?view=trash", "/app/contacts?tab=visits", "/app/settings/channels"]); // R101: Files plus entries ride FILES_PLUS_R101 // R115: Plan visits rides MAPS_R115 // R103: Link library rides DOCS_PLUS_R103 // R122: Help center rides HELP_CENTER // R78: Convert hub rides the Tools switch
    expect(base.filter((c) => !flagOn(c, { tools: true })).map((c) => c.to)).toEqual(["/app/docs/help-center", "/app/docs/links", "/app/docs/links?save=page", "/app/files?view=team", "/app/files?view=brand", "/app/files?view=trash", "/app/contacts?tab=visits", "/app/settings/channels"]);
    expect(base.filter((c) => !flagOn(c, { tools: true, helpCenter: true, docsPlus: true, maps: true, filesPlus: true })).map((c) => c.to)).toEqual(["/app/settings/channels"]);
    expect(navCommands.filter((c) => !flagOn(c, { tools: true, helpCenter: true, docsPlus: true, maps: true, filesPlus: true, toolFeatures: [...TOOL_FEATURES] })).map((c) => c.to)).toEqual(["/app/settings/channels"]);
  });
});
