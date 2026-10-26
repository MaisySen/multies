/**
 * R26 (DF-3): AI agent members on MCP. Anyone with a key can list them; adding, editing and pausing
 * one need a full workspace key (agent keys, agent member keys and read only keys are refused). The
 * same services back the app and the REST API (v1-people.ts, v1-r26-agents.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { createAgentMemberR26, listAgentMembers, updateAgentMember } from "../services/suite/agent-members-r26";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional().describe("Avatar colour as #rrggbb.");

export function registerAgentMemberTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("list_agent_members", {
    title: "List AI agent members", annotations: ro,
    description: "AI agent members of the workspace with title, bio, avatar colour and initials, whether they are paused, the agent inbox linked to them (mailbox is optional) and how many keys they have. Assign tasks to one with assignee member:<userId>.",
    inputSchema: {},
  }, tool(async () => ({ agents: await listAgentMembers(deps, actor.orgId) })) as never);

  server.registerTool("create_agent_member", {
    title: "Add an AI agent member", annotations: rw,
    description: "Adds an AI agent member (no seat, no mailbox needed) and returns its first API key, shown once. Needs a full workspace key. Counts against the plan's agent member limit.",
    inputSchema: {
      name: z.string().min(1).max(80), title: z.string().max(80).optional(), bio: z.string().max(500).optional(),
      scope: z.enum(["full", "read"]).default("full").describe("What its first key can do."), avatarColor: color,
      inboxAgentId: z.string().min(1).optional().describe("An existing agent inbox to link to it."),
    },
  }, tool(async (x: { name: string; title?: string; bio?: string; scope: "full" | "read"; avatarColor?: string | null; inboxAgentId?: string }) => {
    writable();
    return createAgentMemberR26(deps, actor as never, x);
  }) as never);

  server.registerTool("update_agent_member", {
    title: "Edit or pause an AI agent member", annotations: rw,
    description: "Changes an agent member's name, title, bio, avatar colour or linked inbox, or pauses it (disabled true: its keys are refused until resumed with disabled false). Needs a full workspace key. Recorded in the audit log.",
    inputSchema: {
      userId: z.string().min(1), name: z.string().min(1).max(80).optional(), title: z.string().max(80).nullable().optional(), bio: z.string().max(500).nullable().optional(),
      avatarColor: color, disabled: z.boolean().optional(), inboxAgentId: z.string().min(1).nullable().optional(),
    },
  }, tool(async (x: { userId: string; name?: string; title?: string | null; bio?: string | null; avatarColor?: string | null; disabled?: boolean; inboxAgentId?: string | null }) => {
    writable();
    const { userId, ...patch } = x;
    return { agent: await updateAgentMember(deps, actor as never, userId, patch) };
  }) as never);
}
