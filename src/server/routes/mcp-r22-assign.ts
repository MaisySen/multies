/**
 * Round 22 (R22.1 and R22.5): thread assignment, status and reply times on MCP. Read only keys and
 * tokens can list and read stats; assigning and changing status need a write key. The same services
 * back the app and the REST API (v1-r22-assign.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Deps } from "../context";
import { listThreads, scopeFor } from "../services/agents";
import type { SuiteActor } from "../services/suite/common";
import { assignThread, replyStats, setThreadStatus, viewerOf, type ThreadView } from "../services/mail/thread-state";
import type { Scoped } from "./mcp-server";

type Tool = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<unknown>;

export function registerAssignTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void, tool: Tool) {
  const a = actor as unknown as SuiteActor;
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("assign_thread", {
    title: "Assign a shared inbox thread", annotations: rw,
    description: "Gives a mail thread an owner: a workspace member (userId) who can open the thread's mailbox. They get a notification unless they assigned it to themselves. Pass userId null to unassign.",
    inputSchema: { threadId: z.string().min(1), userId: z.string().min(1).nullable() },
  }, tool(async (x: { threadId: string; userId: string | null }) => {
    writable();
    return { state: await assignThread(deps, a, x.threadId, x.userId) };
  }) as never);

  server.registerTool("unassign_thread", {
    title: "Unassign a shared inbox thread", annotations: rw,
    description: "Takes the owner off a mail thread, so it shows under Unassigned again.",
    inputSchema: { threadId: z.string().min(1) },
  }, tool(async (x: { threadId: string }) => {
    writable();
    return { state: await assignThread(deps, a, x.threadId, null) };
  }) as never);

  server.registerTool("set_thread_status", {
    title: "Mark a thread done, waiting or reopen it", annotations: rw,
    description: "status done takes the thread out of the open lists (All, Mine, Unassigned) and records when; waiting means we replied and the customer has the ball (it shows under Waiting and goes back to open when they write); open brings it back.",
    inputSchema: { threadId: z.string().min(1), status: z.enum(["open", "waiting", "done"]) },
  }, tool(async (x: { threadId: string; status: "open" | "waiting" | "done" }) => {
    writable();
    return { state: await setThreadStatus(deps, a, x.threadId, x.status) };
  }) as never);

  server.registerTool("list_threads_by_view", {
    title: "List threads by owner or status", annotations: ro,
    description: "Shared inbox threads, newest first, in one view: open (every open thread), mine (open and assigned to me), unassigned, assigned (to assignee, or to anyone), waiting (we replied, the customer has the ball), done, or all. Each thread carries its assignee and status. Pass before from nextCursor for the next page.",
    inputSchema: {
      view: z.enum(["all", "open", "mine", "unassigned", "assigned", "waiting", "done"]).default("open"),
      assignee: z.string().optional().describe("A user id, for the assigned, waiting and done views."),
      mailboxId: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
  }, tool(async (x: { view: ThreadView; assignee?: string; mailboxId?: string; before?: string; limit: number }) => {
    const scope = await scopeFor(deps, actor);
    return listThreads(deps, actor.orgId, scope, { mailboxId: x.mailboxId, before: x.before, limit: x.limit, view: x.view, assignee: x.assignee, viewerUserId: viewerOf(a) });
  }) as never);

  server.registerTool("get_reply_stats", {
    title: "Reply times", annotations: ro,
    description: "First response and resolution times for threads whose first inbound message falls in the range (default the last 30 days, at most 90), per mailbox or per person, in calendar hours (milliseconds in the answer). At most 2,000 threads are scanned; sampled: true says the answer was cut.",
    inputSchema: {
      mailboxId: z.string().optional(),
      from: z.string().max(40).optional().describe("ISO date or time."),
      to: z.string().max(40).optional().describe("ISO date or time."),
      groupBy: z.enum(["mailbox", "person"]).default("mailbox"),
    },
  }, tool(async (x: { mailboxId?: string; from?: string; to?: string; groupBy: "mailbox" | "person" }) => replyStats(deps, a, x)) as never);
}
