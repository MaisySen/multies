/**
 * The MCP endpoint. The MCP SDK is loaded on the first MCP request, not at Worker startup,
 * to keep startup inside Cloudflare's CPU limit.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
import type { Scoped } from "./mcp-server";
import { toolListChoice } from "../lib/api-scopes";

function isJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

export function registerMcpRoute(api: OpenAPIHono<AppEnv>) {
  api.all("/mcp", async (c) => {
    const base = c.var.auth as Scoped;
    // T1G (T1-1): a body that is not JSON is the caller's mistake: a JSON-RPC parse error (400), never a 500.
    if (c.req.method === "POST") {
      const raw = await c.req.raw.clone().text();
      if (!isJson(raw)) return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: the request body is not valid JSON." }, id: null }, 400);
    }
    const { handleMcp } = await import("./mcp-server");
    // R37: per connection choice (?tools=scoped or ?tools=all, or the X-Multies-Tools header) beats the key's own setting.
    const choice = toolListChoice(c.req.query("tools"), c.req.header("x-multies-tools"));
    const toolList = choice ?? base.toolList;
    return handleMcp(c, { ...base, toolList, sessionId: `mcp:${base.sessionId}` });
  });
}
