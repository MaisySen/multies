/**
 * R28 (found by Haajir): docs_append over MCP. Adds markdown (or plain text) to the end of a doc
 * without sending the whole doc back, with an optional version check. Same service as
 * POST /api/v1/docs/{id}/append (docs.ts appendToDoc).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { appendToDoc } from "../services/suite/docs";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerDocsR28Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("docs_append", {
    title: "Append markdown to a doc", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Adds a section to the end of a doc and keeps everything already there. markdown takes headings, paragraphs, bullet, numbered and task lists, quotes, code, bold, italic, strike and links. Pass ifVersion (the version read_doc gave you) to fail with version_conflict instead of writing if the doc changed since.",
    inputSchema: { id: z.string().min(1), markdown: z.string().min(1).max(200_000), ifVersion: z.number().int().optional() },
  }, tool(async (x: { id: string; markdown: string; ifVersion?: number }) => {
    writable();
    const d = await appendToDoc(deps, a, x.id, x.markdown, { markdown: true, ifVersion: x.ifVersion });
    return { id: d.id, title: d.title, version: d.version, updatedAt: d.updatedAt };
  }) as never);
}
