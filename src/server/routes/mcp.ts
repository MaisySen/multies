/**
 * The MCP endpoint. The MCP SDK is loaded on the first MCP request, not at Worker startup,
 * to keep startup inside Cloudflare's CPU limit.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
import type { Scoped } from "./mcp-server";

export function registerMcpRoute(api: OpenAPIHono<AppEnv>) {
  api.all("/mcp", async (c) => {
    const base = c.var.auth as Scoped;
    const { handleMcp } = await import("./mcp-server");
    return handleMcp(c, { ...base, sessionId: `mcp:${base.sessionId}` });
  });
}
