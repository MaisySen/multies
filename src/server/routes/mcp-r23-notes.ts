/**
 * Round 23 (R23.5): meeting notes over MCP. Read only keys and tokens can read the notes; creating
 * action items needs a write key. Agent keys create tasks as their agent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createActionItems, meetingNotes } from "../services/suite/meeting-notes";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerMeetingNotesTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;

  server.registerTool("get_meeting_notes", {
    title: "Get a meeting's notes", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "A meeting's title, time and attendees with its notes doc as plain structure: agenda lines, notes lines, and action items (each with title, assignee, due date and, once made, its task). doc is null when no notes were taken yet. summary is null unless a recording summary exists.",
    inputSchema: { meetingId: z.string().min(1) },
  }, tool(async (x: { meetingId: string }) => {
    const n = await meetingNotes(deps, a, x.meetingId);
    return { meeting: n.meeting, timeZone: n.timeZone, doc: n.doc ? { id: n.doc.id, title: n.doc.title, text: n.doc.text, updatedAt: n.doc.updatedAt } : null, agenda: n.agenda, notes: n.notes, actionItems: n.actionItems, summary: n.summary };
  }) as never);

  server.registerTool("create_action_items", {
    title: "Turn meeting action items into tasks", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "With no items: every unchecked action item in the meeting's notes that is not a task yet becomes a task (assignee and due date read from \"@Name\" and \"due Fri\" style text). With items: each is added to the notes' action items and made a task. Items already made into tasks are skipped, so calling twice creates nothing new. Each task links back to the meeting. Returns the tasks created.",
    inputSchema: {
      meetingId: z.string().min(1),
      items: z.array(z.object({
        title: z.string().min(1).max(500),
        assignee: z.string().max(320).optional().describe("member:<userId>, agent:<agentId>, or a name or email in the workspace."),
        due: z.string().max(40).optional().describe("YYYY-MM-DD"),
      })).max(50).optional(),
      projectId: z.string().min(1).optional().describe("Defaults to the meeting's source task's project, else the workspace's first project."),
    },
  }, tool(async (x: { meetingId: string; items?: { title: string; assignee?: string; due?: string }[]; projectId?: string }) => {
    writable();
    return createActionItems(deps, a, x.meetingId, { items: x.items, projectId: x.projectId });
  }) as never);
}
