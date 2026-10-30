/**
 * R32: docs_add_block over MCP. Adds a table, an image (https link) or a callout to the end of a
 * doc, with the same optional version check as docs_append (appendToDoc in docs.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { appendToDoc } from "../services/suite/docs";
import { blockMarkdown, type DocBlockInput } from "../services/suite/doc-blocks-r32";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerDocsR32Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("docs_add_block", {
    title: "Add a table, image or callout to a doc", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Adds one block to the end of a doc and keeps everything already there. type table takes rows (an array of rows of cell text; the first row is the header unless header is false). type image takes an https url and alt text. type callout takes text (markdown) and a variant: info, success, warning or danger. Pass ifVersion to fail with version_conflict if the doc changed since you read it.",
    inputSchema: {
      id: z.string().min(1),
      type: z.enum(["table", "image", "callout"]),
      rows: z.array(z.array(z.string().max(2000)).max(30)).max(500).optional(),
      header: z.boolean().optional(),
      url: z.string().max(2000).optional(),
      alt: z.string().max(300).optional(),
      text: z.string().max(50_000).optional(),
      variant: z.enum(["info", "success", "warning", "danger"]).optional(),
      ifVersion: z.number().int().optional(),
    },
  }, tool(async (x: { id: string; type: "table" | "image" | "callout"; rows?: string[][]; header?: boolean; url?: string; alt?: string; text?: string; variant?: "info" | "success" | "warning" | "danger"; ifVersion?: number }) => {
    writable();
    const block: DocBlockInput = x.type === "table" ? { type: "table", rows: x.rows ?? [], header: x.header }
      : x.type === "image" ? { type: "image", url: x.url ?? "", alt: x.alt }
      : { type: "callout", variant: x.variant, text: x.text ?? "" };
    const d = await appendToDoc(deps, a, x.id, blockMarkdown(block), { markdown: true, ifVersion: x.ifVersion });
    return { id: d.id, title: d.title, version: d.version, updatedAt: d.updatedAt };
  }) as never);
}
