/**
 * The MCP endpoint. The MCP SDK is loaded on the first MCP request, not at Worker startup,
 * to keep startup inside Cloudflare's CPU limit.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
import type { Scoped } from "./mcp-server";
import { toolListChoice } from "../lib/api-scopes";

export function registerMcpRoute(api: OpenAPIHono<AppEnv>) {
  api.all("/mcp", async (c) => {
    const base = c.var.auth as Scoped;
    const { handleMcp } = await import("./mcp-server");
    // R37: per connection choice (?tools=scoped or ?tools=all, or the X-Multies-Tools header) beats the key's own setting.
    const choice = toolListChoice(c.req.query("tools"), c.req.header("x-multies-tools"));
    const toolList = choice ?? base.toolList;
    return handleMcp(c, { ...base, toolList, sessionId: `mcp:${base.sessionId}` });
  });
}
