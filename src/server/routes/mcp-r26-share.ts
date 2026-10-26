/**
 * R26 (MB-87): share links over MCP: create_share_link, list_share_links and revoke_share_link, the same as
 * /api/v1/share-links. Making or revoking needs a write key; agent keys are refused (an agent never hands out a
 * public link), and another workspace's doc, project or link is not found.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { createShareLink, listShareLinks, revokeShareLink } from "../services/suite/share-links";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const rw = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerShareLinkTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as Parameters<typeof createShareLink>[1];

  server.registerTool("create_share_link", {
    title: "Make a read only share link", annotations: rw,
    description: "Makes a link anyone can open without signing in: a doc (kind doc) read only, or a project's board (kind project_board) with its columns, card titles, assignee initials, due dates and labels; never notes, comments, files or custom fields. expiresInDays 7 or 30, or leave it out for never. showWorkspaceName (default true) shows the workspace name on the page. The url is shown only this once. Writes one row.",
    inputSchema: {
      kind: z.enum(["doc", "project_board"]),
      targetId: z.string().min(1).describe("The doc id, or the project id for a board."),
      expiresInDays: z.union([z.literal(7), z.literal(30)]).nullable().optional(),
      showWorkspaceName: z.boolean().optional(),
    },
  }, tool(async (x: { kind: "doc" | "project_board"; targetId: string; expiresInDays?: 7 | 30 | null; showWorkspaceName?: boolean }) => {
    writable();
    return { link: (await createShareLink(deps, a, x)).link };
  }) as never);

  server.registerTool("list_share_links", {
    title: "List active share links", annotations: ro,
    description: "Active share links (not revoked, not expired), newest first, for one doc or project when kind and targetId are given. Links never show their token again.",
    inputSchema: { kind: z.enum(["doc", "project_board"]).optional(), targetId: z.string().optional() },
  }, tool(async (x: { kind?: "doc" | "project_board"; targetId?: string }) => listShareLinks(deps, a, x)) as never);

  server.registerTool("revoke_share_link", {
    title: "Revoke a share link", annotations: { ...rw, idempotentHint: true },
    description: "Stops a share link at once; its page then says the link is no longer active.",
    inputSchema: { id: z.string().min(1).describe("The link id (shl_...).") },
  }, tool(async (x: { id: string }) => {
    writable();
    return revokeShareLink(deps, a, x.id);
  }) as never);
}
