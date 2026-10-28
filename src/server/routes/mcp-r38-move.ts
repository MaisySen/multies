/**
 * R38 move your data over MCP: export_workspace answers a download link for the whole workspace, list_data_moves the
 * import and export history, import_file brings a file in (one step; call again with moveId while it says stopped),
 * undo_import removes exactly what an import made. Same services as /api/v1/data-moves.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { listMoves, runMove, startExport, undoMove } from "../services/data-move/service";
import type { Scoped } from "./mcp-server";
import { mcpCreate } from "./mcp-idempotency"; // R53 (MB-239)

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerDataMoveTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const base = (deps.config as { appUrl?: string }).appUrl ?? "";

  server.registerTool("export_workspace", {
    title: "Export the whole workspace", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Starts a full workspace export and answers downloadUrl, a ZIP link that works for 24 hours: JSON for every table, CSV for tasks, projects, comments, contacts, deals, time and chat, Markdown docs, an .ics calendar, a .vcf address book and mbox mail. One export every 10 minutes.",
    inputSchema: {},
  }, tool(async () => {
    const r = await startExport(deps, a);
    return { id: r.id, downloadUrl: `${base}${r.downloadPath}`, expiresAt: r.expiresAt, counts: r.counts };
  }) as never);

  server.registerTool("list_data_moves", {
    title: "List imports and exports", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The last 50 imports and exports: kind, source, status, done of total, how many items each made and whether it can be undone.",
    inputSchema: {},
  }, tool(async () => listMoves(deps, a)) as never);

  server.registerTool("import_file", {
    title: "Import a file", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Brings a file in. kind: tasks (CSV, Excel as xlsx-base64:, Trello JSON, or a Markdown and CSV zip as zip-base64:), calendar (.ics), contacts (.vcf or CSV), docs (Markdown, or a zip of pages) or workspace (an export zip). Runs about 15 seconds; while move.status is stopped, call again with the same content and moveId. Re-running a tasks file skips tasks already in.",
    inputSchema: { kind: z.enum(["tasks", "calendar", "contacts", "docs", "workspace"]), content: z.string().min(1).max(8_000_000), fileName: z.string().max(255).optional(), projectId: z.string().optional(), projectName: z.string().max(120).optional(), moveId: z.string().optional() },
  }, tool(async (x: { kind: "tasks" | "calendar" | "contacts" | "docs" | "workspace"; content: string; fileName?: string; projectId?: string; projectName?: string; moveId?: string }) => {
    writable();
    const run = await mcpCreate("mov"); // R53 (MB-239): one run, one project on a retry under the same key
    const r = await runMove(deps, a, x, run.id ? { moveId: run.id, projectId: (await mcpCreate("prj")).id, retry: run.retry } : {});
    return { move: r.move, stopped: r.stopped };
  }) as never);

  server.registerTool("undo_import", {
    title: "Undo an import", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Removes exactly what one import made (its tasks with their comments, the statuses and projects it added when nothing else uses them, and its meetings, contacts and docs). Take the id from list_data_moves.",
    inputSchema: { id: z.string().min(1) },
  }, tool(async (x: { id: string }) => { writable(); return undoMove(deps, a, x.id); }) as never);
}
