import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { WIDGET_TYPES } from "@/server/services/suite/dashboards";
import { widgetCatalog } from "@/server/services/suite/dashboard-widget-catalog-r39";

/** R39: the dashboard widget catalog (list_dashboard_widget_types, GET /dashboards/widget-types). */
describe("dashboard widget catalog", () => {
  it("lists every widget type once, with a default chart it allows and defaults inside their values", () => {
    const c = widgetCatalog();
    expect(c.types.map((t) => t.type)).toEqual([...WIDGET_TYPES]);
    expect(c.maxWidgets).toBe(24);
    for (const t of c.types) {
      expect(t.label.length, t.type).toBeGreaterThan(1);
      expect(t.charts, t.type).toContain(t.defaultChart);
      expect([1, 2]).toContain(t.defaultSize);
      for (const o of t.options) if (o.values && o.default !== undefined && o.default !== null) expect(o.values, `${t.type}.${o.name}`).toContain(String(o.default));
      expect(`${t.label} ${t.what} ${t.options.map((o) => o.what).join(" ")}`, t.type).not.toMatch(/[\u2013\u2014]/);
    }
    const calc = c.types.find((t) => t.type === "calculation")!;
    expect(calc.options.map((o) => o.name)).toEqual(["metric", "op", "range", "goal"]);
    expect(c.types.find((t) => t.type === "pivot")!.options.find((o) => o.name === "columnBy")?.default).toBe("status");
  });

  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  beforeEach(async () => {
    ctx = await makeTestApp();
    c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
  });

  it("answers on the session API, v1 with a read only key, and MCP", async () => {
    const s = await c.get("/api/dashboards/widget-types");
    expect(s.status).toBe(200);
    expect(s.body.types).toHaveLength(WIDGET_TYPES.length);

    const ro = (await c.post("/api/developer/keys", { name: "ro", scope: "read" })).body.secret as string;
    const h = { authorization: `Bearer ${ro}` };
    const v = await ctx.app.request("/api/v1/dashboards/widget-types", { headers: h });
    expect(v.status).toBe(200);
    expect(((await v.json()) as { types: unknown[] }).types).toHaveLength(WIDGET_TYPES.length);
    expect((await ctx.app.request("/api/v1/dashboards/widget-types")).status).toBe(401);

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const m = new McpClient({ name: "test", version: "1.0.0" });
    await m.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: h }, fetch: fetchViaApp }));
    const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text);
    const all = await m.callTool({ name: "list_dashboard_widget_types", arguments: {} });
    expect(all.isError).toBeFalsy();
    expect(text(all).types).toHaveLength(WIDGET_TYPES.length);
    const one = text(await m.callTool({ name: "list_dashboard_widget_types", arguments: { type: "pivot" } }));
    expect(one.types).toHaveLength(1);
    expect(one.types[0].options.map((o: { name: string }) => o.name)).toEqual(["groupBy", "columnBy"]);
    await m.close();
  });
});
