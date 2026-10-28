/**
 * Round 21 (R21.3): the Triage queue on MCP. Read only keys can list; accept, decline, merge and
 * create need a write key. The same services back the app and the REST API.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { parseAssignee } from "../services/suite/tasks";
import { acceptTriage, createTriageItem, declineTriage, listTriage, mergeTriage } from "../services/suite/triage";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerTriageTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool("list_triage", {
    title: "List the Triage queue", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "New work waiting in Triage (from mail rules, public forms, incoming hooks or the API), newest first, before it becomes a normal task. Accept, decline or merge each one.",
    inputSchema: { projectId: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  }, tool(async (x: { projectId?: string; limit?: number }) => {
    const r = await listTriage(deps, a, x);
    return {
      count: r.count,
      items: r.items.map((t) => ({ id: t.id, ref: t.ref, title: t.title, notes: t.notes.slice(0, 2000), projectId: t.projectId, source: t.triage?.source ?? null, from: t.triage?.from ?? null, subject: t.source?.subject ?? null, threadId: t.source?.threadId ?? null, createdAt: t.createdAt })),
    };
  }) as never);

  server.registerTool("triage_accept", {
    title: "Accept a Triage item", annotations: rw,
    description: "Makes a Triage item a normal task, in the same step optionally setting its project, assignee (member:<userId> or agent:<agentId>), status, priority and due date.",
    inputSchema: {
      id: z.string().min(1),
      projectId: z.string().optional(),
      assignee: z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional(),
      status: z.enum(["todo", "doing", "done"]).optional(),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
      due: z.string().max(40).nullable().optional().describe("ISO date or time, or null."),
    },
  }, tool(async (x: { id: string; projectId?: string; assignee?: string | null; status?: "todo" | "doing" | "done"; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string | null }) => {
    writable();
    const { id, assignee, ...rest } = x;
    return { task: await acceptTriage(deps, a, id, { ...rest, assignee: assignee === undefined ? undefined : parseAssignee(assignee) }) };
  }) as never);

  server.registerTool("triage_decline", {
    title: "Decline a Triage item", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description: "Declines and deletes a Triage item with an optional reason. reply: true also emails the sender a short polite note (skipped for no-reply addresses); message replaces the default text.",
    inputSchema: { id: z.string().min(1), reason: z.string().max(500).optional(), reply: z.boolean().optional(), message: z.string().max(5000).optional() },
  }, tool(async (x: { id: string; reason?: string; reply?: boolean; message?: string }) => {
    writable();
    return declineTriage(deps, a, x.id, x);
  }) as never);

  server.registerTool("triage_merge", {
    title: "Merge a Triage item into a task", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: "Folds a Triage item into an existing task: its notes become a comment on the target, its mail thread moves to the target when the target has none, and the item is deleted.",
    inputSchema: { id: z.string().min(1), targetId: z.string().min(1).describe("The task id to merge into.") },
  }, tool(async (x: { id: string; targetId: string }) => {
    writable();
    return mergeTriage(deps, a, x.id, x.targetId);
  }) as never);

  server.registerTool("create_triage_item", {
    title: "Add an item to Triage", annotations: rw,
    description: "Puts new work in the Triage queue for a person to accept, instead of making a task straight away. from is an email address to reply to, if any. Without projectId it goes to the default project.",
    inputSchema: {
      title: z.string().min(1).max(300), notes: z.string().max(20_000).optional(),
      source: z.enum(["mail", "form", "api", "chat"]).optional(), from: z.string().max(300).optional(), projectId: z.string().optional(),
    },
  }, tool(async (x: { title: string; notes?: string; source?: "mail" | "form" | "api" | "chat"; from?: string; projectId?: string }) => {
    writable();
    return { item: await createTriageItem(deps, a, x) };
  }) as never);
}
