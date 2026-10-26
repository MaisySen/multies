import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { buildMcpServer } from "@/server/routes/mcp-server";
import { mcpCatalog } from "@/server/services/developer/mcp-catalog";
import { MCP_RECIPES } from "@/shared/mcp-recipes";

/** R36: the public MCP tool docs are generated from the server, so a tool can't exist without docs. */
describe("MCP tool catalog", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = buildMcpServer({ config: { release: "t" } } as any, { orgId: "o", userId: "u", role: "admin", scope: "full", agentId: null } as any, "https://multies.si") as any;
  const registered = server._registeredTools as Record<string, { inputSchema?: { safeParse: (v: unknown) => { success: boolean; error?: unknown } } }>;
  const catalog = mcpCatalog("t");

  it("documents every tool the server registers, with a description, a scope and an example", () => {
    expect(catalog.map((t) => t.name).sort()).toEqual(Object.keys(registered).sort());
    const undocumented = catalog.filter((t) => t.description.trim().length < 20 || !t.scope || t.scope === "full" || !t.areaLabel).map((t) => t.name);
    expect(undocumented).toEqual([]);
    for (const t of catalog) for (const p of t.params) expect(p.type, `${t.name}.${p.name}`).toBeTruthy();
  });

  it("gives every tool an example call its own input schema accepts", () => {
    const bad = catalog.filter((t) => {
      const s = registered[t.name].inputSchema;
      return s ? !s.safeParse(t.example.arguments).success : false;
    }).map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("only uses real tools in the recipes", () => {
    expect(MCP_RECIPES.length).toBeGreaterThanOrEqual(4);
    const names = new Set(catalog.map((t) => t.name));
    const unknown = MCP_RECIPES.flatMap((r) => r.steps.map((s) => s.tool)).filter((n) => !names.has(n));
    expect(unknown).toEqual([]);
    const invalid = MCP_RECIPES.flatMap((r) => r.steps.filter((s) => registered[s.tool]?.inputSchema && !registered[s.tool].inputSchema!.safeParse(s.arguments).success).map((s) => `${r.id}:${s.tool}`));
    expect(invalid).toEqual([]);
    // Zod drops unknown keys, so check the names too: a recipe must not teach a parameter that does not exist.
    const byName = new Map(catalog.map((t) => [t.name, new Set(t.params.map((p) => p.name))]));
    const extra = MCP_RECIPES.flatMap((r) => r.steps.flatMap((s) => Object.keys(s.arguments).filter((k) => !byName.get(s.tool)?.has(k)).map((k) => `${r.id}:${s.tool}.${k}`)));
    expect(extra).toEqual([]);
  });

  it("serves the catalog as JSON and Markdown without a key", async () => {
    const ctx = await makeTestApp();
    const res = await ctx.app.request("/api/mcp-tools", { headers: { host: "localhost" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools.length).toBe(catalog.length);
    const md = await ctx.app.request("/developers/mcp.md", { headers: { host: "localhost" } });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const text = await md.text();
    for (const t of catalog) expect(text).toContain(`### ${t.name}`);
  });
});
