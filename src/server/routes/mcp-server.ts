/**
 * The MCP server: Multies' agent tools for Claude, ChatGPT, Cursor and any MCP client.
 * Streamable HTTP, stateless: each request builds a server bound to the caller's API key,
 * so an agent key only ever sees and sends as its own agent.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import type { Context } from "hono";
import type { AppEnv, Deps } from "../context";
import { HttpError } from "../lib/errors";
import { listMailboxes, updateMailbox } from "../services/addresses";
import type { SuiteActor } from "../services/suite/common";
import type { SearchType } from "../services/search";
import type { TaskType } from "../services/suite/task-types";
import { addComment, createTask, createTaskFromThread, listProjects, listTasks, nextTaskFor, parseAssignee, taskDetail, updateTask } from "../services/suite/tasks";
import { appendToDoc, createDoc, getDoc, listDocs } from "../services/suite/docs";
import { contactDetail, listContacts, upsertContact } from "../services/suite/contacts";
import { addEntry, startTimer, stopTimer, timesheet } from "../services/suite/time";
import { addDependency, removeDependency } from "../services/suite/tasks";
import { createForm, listForms } from "../services/suite/forms";
import { dashboard } from "../services/suite/reports";
import { createMeeting, listMeetings } from "../services/suite/meetings";
import { createField, listFields, type FilterOp } from "../services/suite/fields";
import { inviteGuest, listGuests } from "../services/suite/guests";
import { portfolio } from "../services/suite/portfolio";
import { channelMessages, getThread, listChannels, messageToTask, pinMessage, postMessage } from "../services/suite/chat";
import { listTemplates, saveTemplate, useTemplate, type TemplateKind } from "../services/suite/templates";
import { createGoal, goalTree, updateKeyResult } from "../services/suite/goals";
import { listNotifications } from "../services/suite/notify";
import { updateProject } from "../services/suite/tasks";
import {
  createAgent, eventsSince, getAgent, latestEventSeq, listAgents, listThreads, readThread, replyInThread, requestSend, scopeFor, searchMessages, type Actor,
} from "../services/agents";

import { registerMailScheduleTools } from "./mcp-mail-schedule";
import { registerTaskTypeTools } from "./mcp-r21-types";
import { registerSprintTools } from "./mcp-r21-sprints";
import { registerTriageTools } from "./mcp-r21-triage";
import { registerThreadCommentTools } from "./mcp-r22-comments";
import { registerSnippetTools } from "./mcp-r22-snippets";
import { registerAssignTools } from "./mcp-r22-assign";
import { registerAgentMemberTools } from "./mcp-r26-agents"; // R26 (DF-3)
import { registerChecklistTools } from "./mcp-r26-checklists"; // R26 (MB-85)
import { registerTaskQueryTools } from "./mcp-r26-task-query"; // R26 (MB-86)
import { registerAgentRunTools } from "./mcp-r27-agent-runs"; // R27 (DF-3 slice 2)
import { registerCalendarTools } from "./mcp-r23-calendar";
import { registerPresenceTools } from "./mcp-r22-presence";
import { registerMeetingNotesTools } from "./mcp-r23-notes";
import { registerRecordingTools } from "./mcp-r23-recordings";
import { registerCallTools } from "./mcp-r23-calls";
import { registerWorkloadTools } from "./mcp-r24-workload";
import { registerRecipeTools } from "./mcp-r24-recipes";
import { registerR24DocTools } from "./mcp-r24-docs";
import { registerDashboardTools } from "./mcp-r24-dashboards";
import { registerFormulaTools } from "./mcp-r24-formulas";
import { registerSavedViewTools } from "./mcp-views";
import { registerTaskBulkTools } from "./mcp-r21-table";
import { registerAuthMailTools } from "./mcp-r25-authmail"; // R25 (MB-60)
import { registerR26CommentTools } from "./mcp-r26-comments"; // R26 (MB-77)
import { registerShareLinkTools } from "./mcp-r26-share"; // R26 (MB-87)

export type Scoped = Actor & { scope?: "full" | "read" };

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Tool errors go back to the model as text it can act on, not as protocol errors. */
function tool<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try { return ok(await fn(args)); } catch (err) {
      if (err instanceof HttpError) return fail(`${err.code}: ${err.message}`);
      throw err;
    }
  };
}

export function buildMcpServer(deps: Deps, actor: Scoped, origin: string) {
  const server = new McpServer({ name: "mymail", title: "Multies", version: deps.config.release, websiteUrl: origin },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator(), instructions: actor.agentId
      ? "You are connected as one Multies agent inbox. Read threads, search, send or reply as this agent, and pick up tasks assigned to you (next_task), comment on them and mark them done. Sends may wait for a person to approve them; the result says so."
      : "You are connected to a Multies workspace. List inboxes, read and search mail, create agent inboxes, send or reply as an agent (pass agentId), and work with tasks, projects, docs and contacts." });
  const writable = () => { if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read."); };
  const agentFor = async (agentId?: string) => {
    if (!actor.agentId && actor.role === "member") throw new HttpError(403, "agent_member_key_scope", "An agent member's key can't send mail as an agent inbox. Use that agent's own key.");
    const id = actor.agentId ?? agentId;
    if (!id) throw new HttpError(422, "agent_required", "Pass agentId: sends always go out as an agent inbox. Call list_inboxes to see them.");
    if (actor.agentId && agentId && agentId !== actor.agentId) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    return getAgent(deps, actor.orgId, id);
  };
  const ro = { readOnlyHint: true, openWorldHint: false };

  server.registerTool("list_inboxes", {
    title: "List inboxes", annotations: ro,
    description: "The inboxes this key can use: agent inboxes (with their approval rules and today's sends) and, for workspace keys, the team's mailboxes.",
  }, tool(async () => {
    const agents = (await listAgents(deps, actor.orgId)).filter((a) => !actor.agentId || a.id === actor.agentId);
    const scope = await scopeFor(deps, actor);
    const boxes = (await listMailboxes(deps.db, actor.orgId)).filter((m) => !scope || scope.includes(m.id));
    return {
      agents: agents.map((a) => ({ agentId: a.id, name: a.name, address: a.address, approvalMode: a.approvalMode, sentToday: a.sentToday, sendCapDaily: a.sendCapDaily, status: a.status, mailboxIds: a.mailboxIds })),
      mailboxes: boxes.map((m) => ({ mailboxId: m.id, address: m.address, name: m.displayName, replyTo: m.replyTo ?? null })),
    };
  }));

  server.registerTool("list_threads", {
    title: "List threads", annotations: ro,
    description: "Recent threads, newest first, with sender, snippet, unread count and which agents took part.",
    inputSchema: {
      agentId: z.string().optional().describe("Only this agent's inboxes. Agent keys always use their own."),
      mailboxId: z.string().optional(),
      unread: z.boolean().optional().describe("Only threads with unread mail."),
      limit: z.number().int().min(1).max(50).default(20),
    },
  }, tool(async (a: { agentId?: string; mailboxId?: string; unread?: boolean; limit: number }) => {
    const scope = actor.agentId || a.agentId ? (await agentFor(a.agentId)).mailboxIds : await scopeFor(deps, actor);
    return listThreads(deps, actor.orgId, scope, { mailboxId: a.mailboxId, unread: a.unread, limit: a.limit });
  }));

  server.registerTool("read_thread", {
    title: "Read a thread", annotations: ro,
    description: "Every message in a thread: the new text with quoted history removed, one-time codes, links, attachments, who wrote it (agent, person or outside sender), and any reply waiting for approval.",
    inputSchema: { threadId: z.string() },
  }, tool(async (a: { threadId: string }) => readThread(deps, actor, a.threadId, origin)));

  server.registerTool("search", {
    title: "Search mail", annotations: ro,
    description: "Search subject, sender, recipients and body across the mail this key can read.",
    inputSchema: { query: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(10) },
  }, tool(async (a: { query: string; limit: number }) => ({ results: await searchMessages(deps, actor, a.query, a.limit) })));

  // Round 20: search everything this key can open, and what is waiting today. Reads only.
  server.registerTool("search_everything", {
    title: "Search everything", annotations: ro,
    description: "One search across mail, tasks (title, notes or a key like OPS-12), docs, chat, contacts and deals, grouped by type, newest first. Only what this key can open: an agent key sees its own inboxes and public channels.",
    inputSchema: { q: z.string().min(2).max(100), types: z.array(z.enum(["mail", "tasks", "docs", "chat", "contacts", "deals"])).optional(), limit: z.number().int().min(1).max(20).default(5) },
  }, tool(async (x: { q: string; types?: SearchType[]; limit: number }) => {
    const { searchEverything } = await import("../services/search");
    return searchEverything(deps, { kind: "actor", actor }, x.q, { types: x.types, limit: x.limit });
  }));

  server.registerTool("my_work", {
    title: "My work today", annotations: ro,
    description: "What is waiting today for the person (or, with an agent key, the agent): tasks due today and overdue, mentions, mail threads on my tasks, approvals waiting and today's meetings.",
    inputSchema: { timeZone: z.string().max(64).optional().describe("IANA zone for 'today', e.g. Australia/Sydney. Defaults to the person's or workspace's zone.") },
  }, tool(async (x: { timeZone?: string }) => {
    const { myWork } = await import("../services/search");
    return myWork(deps, actor, { timeZone: x.timeZone });
  }));

  server.registerTool("send_email", {
    title: "Send an email", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Send a new email as an agent inbox. Respects the agent's allowed recipients and daily cap. If the agent needs approval, the result is pending_approval and a person decides; do not resend.",
    inputSchema: {
      agentId: z.string().optional().describe("Which agent sends. Not needed with an agent key."),
      to: z.array(z.string().email()).min(1).max(50),
      cc: z.array(z.string().email()).max(50).optional(),
      subject: z.string().max(998),
      text: z.string().min(1).max(200_000).describe("Plain text body."),
    },
  }, tool(async (a: { agentId?: string; to: string[]; cc?: string[]; subject: string; text: string }) => {
    writable();
    const agent = await agentFor(a.agentId);
    return requestSend(deps, { ...actor, agentId: agent.id }, agent.id, { to: a.to.map((x) => x.toLowerCase()), cc: a.cc?.map((x) => x.toLowerCase()), subject: a.subject, text: a.text });
  }));

  server.registerTool("reply", {
    title: "Reply in a thread", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Reply to the latest message from the other side of a thread, threaded with a Re: subject, as an agent. Same rules as send_email.",
    inputSchema: {
      threadId: z.string(),
      text: z.string().min(1).max(200_000),
      replyAll: z.boolean().default(false),
      agentId: z.string().optional().describe("Which agent replies. Not needed with an agent key."),
    },
  }, tool(async (a: { threadId: string; text: string; replyAll: boolean; agentId?: string }) => {
    writable();
    const agent = await agentFor(a.agentId);
    return replyInThread(deps, { ...actor, agentId: agent.id }, agent.id, a.threadId, { text: a.text, replyAll: a.replyAll });
  }));

  server.registerTool("wait_for_email", {
    title: "Wait for new email", annotations: ro,
    description: "Wait up to timeoutSeconds for new mail to an agent inbox (for example a sign up code), then return the new messages, parsed. Pass the cursor from the last call to avoid repeats.",
    inputSchema: {
      agentId: z.string().optional(),
      timeoutSeconds: z.number().int().min(0).max(50).default(25),
      cursor: z.number().int().min(0).optional().describe("The cursor returned by the previous call."),
    },
  }, tool(async (a: { agentId?: string; timeoutSeconds: number; cursor?: number }) => {
    const agent = await agentFor(a.agentId);
    let after = a.cursor ?? (await latestEventSeq(deps, actor.orgId));
    const until = Date.now() + a.timeoutSeconds * 1000;
    for (;;) {
      const events = await eventsSince(deps, { ...actor, agentId: agent.id }, { after, agentId: agent.id, limit: 50 });
      if (events.length) after = events[events.length - 1].id;
      const received = events.filter((e) => e.type === "message.received");
      if (received.length || Date.now() >= until) return { messages: received.map((e) => e.data), cursor: after };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }));

  if (!actor.agentId && actor.role !== "member") {
    server.registerTool("create_agent_inbox", {
      title: "Create an agent inbox", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description: "Create a new agent with its own email address on the workspace's domain. Its sends need a person's approval unless approvalMode says otherwise. Returns the agent and a key for it, shown once.",
      inputSchema: {
        name: z.string().min(1).max(80),
        localPart: z.string().regex(/^[a-z0-9._-]+$/i).max(64).optional().describe("The part before the @."),
        approvalMode: z.enum(["always", "external", "never"]).default("always"),
      },
    }, tool(async (a: { name: string; localPart?: string; approvalMode: "always" | "external" | "never" }) => {
      writable();
      return createAgent(deps, actor, { name: a.name, localPart: a.localPart?.toLowerCase(), approvalMode: a.approvalMode });
    }));

    // MB-61 (R25): a mailbox's default Reply-To, the same as PATCH /api/v1/mailboxes/{id}.
    server.registerTool("set_mailbox_reply_to", {
      title: "Set a mailbox's default Reply-To", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description: "Sets the Reply-To that every send from this mailbox carries when the send names none (for example no-reply@ sends with replies going to support@). Pass replyTo null to clear it. list_inboxes shows each mailbox's current one.",
      inputSchema: {
        mailboxId: z.string(),
        replyTo: z.string().email().max(254).nullable(),
      },
    }, tool(async (a: { mailboxId: string; replyTo: string | null }) => {
      writable();
      const m = await updateMailbox(deps.db, actor.orgId, a.mailboxId, { replyTo: a.replyTo ? a.replyTo.trim().toLowerCase() : null });
      return { mailboxId: m.id, address: m.address, replyTo: m.replyTo ?? null };
    }));
  }

  registerSuiteTools(server, deps, actor, writable);
  registerR7Tools(server, deps, actor, writable);
  registerR8Tools(server, deps, actor, writable);
  registerR11Tools(server, deps, actor, writable);
  registerR10Tools(server, deps, actor, writable);
  registerR20ChatTools(server, deps, actor, writable);
  registerMailScheduleTools(server, deps, actor, writable, agentFor, tool);
  registerTaskTypeTools(server, deps, actor, writable, tool);
  registerSprintTools(server, deps, actor, writable, tool);
  registerTriageTools(server, deps, actor, writable, tool);
  registerAssignTools(server, deps, actor, writable, tool);
  registerChecklistTools(server, deps, actor, writable, tool); // R26 (MB-85)
  registerTaskQueryTools(server, deps, actor, writable, tool); // R26 (MB-86)
  registerAgentRunTools(server, deps, actor, writable, tool); // R27 (DF-3 slice 2)
  registerTaskBulkTools(server, deps, actor, writable, tool);
  registerThreadCommentTools(server, deps, actor, writable, tool);
  registerPresenceTools(server, deps, actor, writable, tool);
  registerSnippetTools(server, deps, actor, writable, tool);
  registerMeetingNotesTools(server, deps, actor, writable, tool); // Round 23: meeting notes
  registerRecordingTools(server, deps, actor, writable, tool);
  registerCallTools(server, deps, actor, writable, tool); // Round 23
  registerWorkloadTools(server, deps, actor, tool); // R24.2: workload
  registerRecipeTools(server, deps, actor, writable, tool); // R24.4: automation recipes
  registerR24DocTools(server, deps, actor, writable, tool); // R24.5: docs tree and backlinks
  registerDashboardTools(server, deps, actor, writable, tool); // R24.3: dashboards
  registerFormulaTools(server, deps, actor, writable, tool); // R24.1: formula and rollup fields
  registerSavedViewTools(server, deps, actor, writable, tool); // DF-20: saved views
  registerCalendarTools(server, deps, actor, writable, tool); // Round 23: calendar
  registerAuthMailTools(server, deps, actor, writable, tool); // R25 (MB-60): branded auth emails
  registerR26CommentTools(server, deps, actor, writable, tool); // R26 (MB-77): comments and chat messages
  registerAgentMemberTools(server, deps, actor, writable, tool); // R26 (DF-3): agent members
  registerShareLinkTools(server, deps, actor, writable, tool); // R26 (MB-87): share links
  return server;
}

/** Tasks, projects, docs and contacts. Internal work: no approval needed. Mail sends keep their rules. */
function registerSuiteTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const a = actor as unknown as SuiteActor;
  const assigneeArg = z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional().describe("member:<userId> or agent:<agentId>. Use \"me\" in list_tasks for your own.");
  const taskType = z.enum(["task", "story", "bug", "epic"]);
  const lite = (t: Awaited<ReturnType<typeof listTasks>>[number]) => ({ id: t.id, ref: t.ref, title: t.title, type: t.type, status: t.status, statusName: t.statusName, priority: t.priority, due: t.due, assignee: t.assignee?.name ?? null, labels: t.labels, threadId: t.source?.threadId ?? null, subtasks: t.subtasks });

  server.registerTool("list_tasks", {
    title: "List tasks", annotations: ro,
    description: "Tasks in the workspace, filtered. assignee takes me, none, member:<id> or agent:<id>. Returns short rows; call get_task for the thread and comments.",
    inputSchema: {
      projectId: z.string().optional(), status: z.enum(["todo", "doing", "done"]).optional(), assignee: z.string().optional(),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(), label: z.string().optional(), q: z.string().max(200).optional(),
      threadId: z.string().optional().describe("Tasks made from this email thread."), limit: z.number().int().min(1).max(200).default(50),
      type: taskType.optional().describe("Only this type."),
    },
  }, tool(async (x: { projectId?: string; status?: "todo" | "doing" | "done"; assignee?: string; priority?: "none" | "low" | "medium" | "high" | "urgent"; label?: string; q?: string; threadId?: string; limit: number; type?: TaskType }) =>
    ({ tasks: (await listTasks(deps, a, x)).map(lite) })));

  server.registerTool("get_task", {
    title: "Get a task", annotations: ro,
    description: "One task by id or reference (OPS-12): fields, subtasks, comments, the email thread it came from (newest text only) and its history.",
    inputSchema: { id: z.string() },
  }, tool(async (x: { id: string }) => taskDetail(deps, a, x.id)));

  server.registerTool("next_task", {
    title: "Next task for this agent", annotations: ro,
    description: "The most urgent open task assigned to this agent, with its thread and comments, or null. Agents with their own key can call this in a loop: take the task, do it, comment, mark it done.",
    inputSchema: { agentId: z.string().optional().describe("Not needed with an agent key.") },
  }, tool(async (x: { agentId?: string }) => {
    const id = actor.agentId ?? x.agentId;
    if (!id) throw new HttpError(422, "agent_required", "Pass agentId, or connect with an agent key.");
    return { next: await nextTaskFor(deps, a, id) };
  }));

  server.registerTool("create_task", {
    title: "Create a task", annotations: rw,
    description: "Create a task. Pass messageId or threadId to make it from an email: the title defaults to the subject and the task links to the thread.",
    inputSchema: {
      title: z.string().max(300).optional().describe("Required unless messageId or threadId is given."), notes: z.string().max(50_000).optional(),
      projectId: z.string().optional(), status: z.enum(["todo", "doing", "done"]).optional(), assignee: assigneeArg,
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(), due: z.string().optional().describe("ISO date, e.g. 2026-10-31."),
      labels: z.array(z.string()).max(20).optional(), parentId: z.string().optional().describe("Make it a subtask."),
      messageId: z.string().optional(), threadId: z.string().optional(),
      type: taskType.optional().describe("task (default), story, bug or epic. Pass an epic's id as parentId to put the task in that epic."),
      points: z.number().min(0).max(1000).optional().describe("The estimate, in the project's unit (points or hours)."),
      sprintId: z.string().max(64).optional().describe("Put the task in a planned or active sprint of its project (see list_sprints)."),
    },
  }, tool(async (x: { title?: string; notes?: string; projectId?: string; status?: "todo" | "doing" | "done"; assignee?: string | null; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string; labels?: string[]; parentId?: string; messageId?: string; threadId?: string; type?: TaskType; points?: number; sprintId?: string }) => {
    writable();
    const assignee = parseAssignee(x.assignee);
    if (x.messageId || x.threadId) return { task: await createTaskFromThread(deps, a, { ...x, assignee }) };
    if (!x.title) throw new HttpError(422, "validation_failed", "Give the task a title, or pass messageId to make it from an email.");
    return { task: await createTask(deps, a, { ...x, title: x.title, assignee }) };
  }));

  server.registerTool("update_task", {
    title: "Update a task", annotations: rw,
    description: "Change a task: status (todo, doing, done) or a project status id, assignee, priority, due date, labels, title, notes, type (task, story, bug, epic), estimate (points) or sprint (sprintId).",
    inputSchema: {
      id: z.string(), title: z.string().max(300).optional(), notes: z.string().max(50_000).optional(), status: z.enum(["todo", "doing", "done"]).optional(), statusId: z.string().optional(),
      assignee: assigneeArg, priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(), due: z.string().nullable().optional(), labels: z.array(z.string()).max(20).optional(),
      type: taskType.optional().describe("task, story, bug or epic."),
      points: z.number().min(0).max(1000).nullable().optional().describe("The estimate in the project's unit; null clears it."),
      sprintId: z.string().max(64).nullable().optional().describe("Move to a sprint of the task's project; null moves it to the backlog."),
    },
  }, tool(async (x: { id: string; title?: string; notes?: string; status?: "todo" | "doing" | "done"; statusId?: string; assignee?: string | null; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string | null; labels?: string[]; type?: TaskType; points?: number | null; sprintId?: string | null }) => {
    writable();
    const { id, ...patch } = x;
    return { task: await updateTask(deps, a, id, { ...patch, assignee: parseAssignee(x.assignee) }) };
  }));

  server.registerTool("comment_on_task", {
    title: "Comment on a task", annotations: rw,
    description: "Add a comment to a task, for example what you did or what you need from a person.",
    inputSchema: { id: z.string(), body: z.string().min(1).max(20_000) },
  }, tool(async (x: { id: string; body: string }) => { writable(); return { comment: await addComment(deps, a, x.id, x.body) }; }));

  server.registerTool("list_projects", {
    title: "List projects", annotations: ro,
    description: "Projects with their ordered statuses (each in a todo, doing or done group) and task counts.",
  }, tool(async () => ({ projects: await listProjects(deps, a.orgId) })));

  server.registerTool("search_docs", {
    title: "Search docs", annotations: ro, description: "Find docs by words in the title or text.",
    inputSchema: { q: z.string().max(200).optional(), projectId: z.string().optional() },
  }, tool(async (x: { q?: string; projectId?: string }) => ({ docs: await listDocs(deps, a.orgId, x) })));

  server.registerTool("read_doc", {
    title: "Read a doc", annotations: ro, description: "A doc's plain text, title and links.",
    inputSchema: { id: z.string() },
  }, tool(async (x: { id: string }) => { const d = await getDoc(deps, a.orgId, x.id); return { id: d.id, title: d.title, text: d.text, links: d.links, version: d.version, updatedAt: d.updatedAt }; }));

  server.registerTool("create_doc", {
    title: "Create a doc", annotations: rw,
    description: "Write a doc from plain text (one paragraph per line, # for headings, - for bullets), optionally linked to a task, project, thread or contact.",
    inputSchema: { title: z.string().max(200), text: z.string().max(200_000), taskId: z.string().optional(), projectId: z.string().optional(), contactId: z.string().optional(), threadId: z.string().optional() },
  }, tool(async (x: { title: string; text: string; taskId?: string; projectId?: string; contactId?: string; threadId?: string }) => {
    writable();
    const links = [x.taskId && { type: "task" as const, id: x.taskId }, x.contactId && { type: "contact" as const, id: x.contactId }, x.threadId && { type: "thread" as const, id: x.threadId }].filter(Boolean) as { type: "task" | "contact" | "thread"; id: string }[];
    const d = await createDoc(deps, a, { title: x.title, text: x.text, projectId: x.projectId, links });
    return { id: d.id, title: d.title, version: d.version };
  }));

  server.registerTool("append_to_doc", {
    title: "Add to a doc", annotations: rw, description: "Add text to the end of a doc without rewriting it.",
    inputSchema: { id: z.string(), text: z.string().min(1).max(200_000) },
  }, tool(async (x: { id: string; text: string }) => { writable(); const d = await appendToDoc(deps, a, x.id, x.text); return { id: d.id, version: d.version }; }));

  server.registerTool("search_contacts", {
    title: "Search contacts", annotations: ro,
    description: "People the workspace has emailed with, made from mail automatically. Search by name or email.",
    inputSchema: { q: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(20) },
  }, tool(async (x: { q?: string; limit: number }) => listContacts(deps, a.orgId, x)));

  server.registerTool("contact_timeline", {
    title: "Contact timeline", annotations: ro,
    description: "Everything with one person (by contact id or email): threads, tasks and deals, newest first.",
    inputSchema: { id: z.string().describe("Contact id or email address.") },
  }, tool(async (x: { id: string }) => contactDetail(deps, a, x.id)));

  server.registerTool("upsert_contact", {
    title: "Save a contact", annotations: rw,
    description: "Create a contact, or update it if the email is already known: name, phone, job title, notes.",
    inputSchema: { email: z.string().email(), name: z.string().max(120).optional(), phone: z.string().max(40).optional(), title: z.string().max(120).optional(), notes: z.string().max(20_000).optional() },
  }, tool(async (x: { email: string; name?: string; phone?: string; title?: string; notes?: string }) => { writable(); return { contact: await upsertContact(deps, a, x) }; }));
}


/** Handles one MCP request (stateless: a fresh server and transport each time). */
export async function handleMcp(c: Context<AppEnv>, actor: Scoped) {
  const server = buildMcpServer(c.var.deps, actor, new URL(c.req.url).origin);
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.body(null, 202);
}


/** Time, dependencies, forms, reports and meetings. Meeting invites go out as an agent, with its approval rules. */
function registerR7Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const a = actor as unknown as SuiteActor;

  server.registerTool("start_timer", {
    title: "Start a timer on a task", annotations: rw,
    description: "Start tracking time on a task (id or reference like OPS-12) as this agent. A timer already running stops first. Needs an agent key.",
    inputSchema: { taskId: z.string(), note: z.string().max(500).optional() },
  }, tool(async (x: { taskId: string; note?: string }) => { writable(); return { entry: await startTimer(deps, a, x) }; }));

  server.registerTool("stop_timer", {
    title: "Stop the running timer", annotations: rw,
    description: "Stop this agent's running timer. Returns the entry with its seconds, or null if nothing was running.",
  }, tool(async () => { writable(); return { entry: await stopTimer(deps, a, {}) }; }));

  server.registerTool("log_time", {
    title: "Log time by hand", annotations: rw,
    description: "Add minutes spent on a task (or a project) on a date (YYYY-MM-DD, default today). Workspace keys pass person (member:<id> or agent:<id>).",
    inputSchema: { taskId: z.string().optional(), projectId: z.string().optional(), minutes: z.number().positive().max(1440), date: z.string().optional(), note: z.string().max(500).optional(), billable: z.boolean().optional(), person: z.string().optional() },
  }, tool(async (x: { taskId?: string; projectId?: string; minutes: number; date?: string; note?: string; billable?: boolean; person?: string }) => { writable(); return { entry: await addEntry(deps, a, x) }; }));

  server.registerTool("get_timesheet", {
    title: "Timesheet", annotations: ro,
    description: "Time per person and project, by day, for a date range (from, to as YYYY-MM-DD; default the last 8 days). Filter by person (me, member:<id>, agent:<id>) or project.",
    inputSchema: { from: z.string().optional(), to: z.string().optional(), person: z.string().optional(), projectId: z.string().optional() },
  }, tool(async (x: { from?: string; to?: string; person?: string; projectId?: string }) => {
    const t = await timesheet(deps, a, x);
    return { from: t.from, to: t.to, days: t.days, total: t.total, rows: t.rows.map((r) => ({ person: r.person.name, project: r.project?.name ?? null, total: r.total, days: r.days })) };
  }));

  server.registerTool("set_task_blocked_by", {
    title: "Set a task as blocked by another", annotations: rw,
    description: "Record that taskId can't start or finish until blockedBy is done (both ids or references). Pass remove: true to take the dependency off. Returns what blocks the task and what it blocks.",
    inputSchema: { taskId: z.string(), blockedBy: z.string(), remove: z.boolean().optional() },
  }, tool(async (x: { taskId: string; blockedBy: string; remove?: boolean }) => {
    writable();
    const d = x.remove ? await removeDependency(deps, a, x.taskId, x.blockedBy) : await addDependency(deps, a, x.taskId, x.blockedBy);
    return { blocked: d.blocked, blockedBy: d.blockedBy.map((t) => ({ ref: t.ref, title: t.title, status: t.status })), blocking: d.blocking.map((t) => ({ ref: t.ref, title: t.title, status: t.status })) };
  }));

  server.registerTool("list_forms", {
    title: "List forms", annotations: ro,
    description: "Public forms in this workspace, with their links and how many times each was submitted.",
  }, tool(async () => ({ forms: (await listForms(deps, a.orgId)).map((f) => ({ id: f.id, name: f.name, url: f.url, target: f.target, enabled: f.enabled, submitCount: f.submitCount, fields: f.fields })) })));

  server.registerTool("create_form", {
    title: "Create a public form", annotations: rw,
    description: "A public form whose submissions become tasks (target task) or contacts (target contact). Fields: label, type (text, email, textarea, phone, select, number, date), required, options for select. Returns the public link.",
    inputSchema: {
      name: z.string().max(120), description: z.string().max(2000).optional(), target: z.enum(["task", "contact"]).optional(), projectId: z.string().optional(),
      fields: z.array(z.object({ label: z.string(), type: z.enum(["text", "email", "textarea", "phone", "select", "number", "date"]), required: z.boolean().optional(), options: z.array(z.string()).optional() })).optional(),
    },
  }, tool(async (x: Parameters<typeof createForm>[2]) => { writable(); return { form: await createForm(deps, a, x) }; }));

  server.registerTool("get_report", {
    title: "Workspace report", annotations: ro,
    description: "Numbers for the last N days (default 30): tasks by status and assignee, overdue tasks, tasks done per day, time per project and the deals pipeline in AUD.",
    inputSchema: { days: z.number().int().min(1).max(366).optional(), projectId: z.string().optional() },
  }, tool(async (x: { days?: number; projectId?: string }) => dashboard(deps, a, x)));

  server.registerTool("list_meetings", {
    title: "List meetings", annotations: ro,
    description: "Video meetings, newest first, with their guest links.",
    inputSchema: { upcoming: z.boolean().optional() },
  }, tool(async (x: { upcoming?: boolean }) => ({ meetings: (await listMeetings(deps, a, { upcoming: x.upcoming, limit: 50 })).map((m) => ({ id: m.id, title: m.title, startsAt: m.startsAt, durationMin: m.durationMin, status: m.status, guestUrl: m.guestUrl, invitees: m.invitees, repeats: m.recurrence ? { rrule: m.recurrence.rrule, timezone: m.recurrence.timezone, summary: m.recurrence.summary } : null })) })));

  server.registerTool("list_people", {
    title: "List people and agents", annotations: ro,
    description: "Everyone in the workspace with title and bio: people (kind human), AI agent members (kind agent) and mail agents (with their inbox).",
    inputSchema: { kind: z.enum(["human", "agent"]).optional() },
  }, tool(async (x: { kind?: "human" | "agent" }) => {
    const { listPeople } = await import("../services/people");
    const people = await listPeople(deps, actor.orgId);
    return { people: x.kind ? people.filter((p) => p.kind === x.kind) : people };
  }));

  server.registerTool("schedule_meeting", {
    title: "Schedule a video meeting", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Schedule a video meeting, optionally from a thread, task or contact (which fills in the title and guests). With sendInvites the calendar invite is emailed as the agent; it may wait for a person to approve it, and the result says so.",
    inputSchema: {
      title: z.string().max(200).optional(), startsAt: z.string().optional().describe("ISO date and time. Default now."), durationMin: z.number().int().min(5).max(480).optional(),
      sourceType: z.enum(["thread", "task", "contact"]).optional(), sourceId: z.string().optional(), invitees: z.array(z.string()).max(50).optional(),
      sendInvites: z.boolean().optional(), agentId: z.string().optional().describe("Workspace keys: the agent inbox the invite is sent from."),
      repeats: z.string().max(200).optional().describe("A weekly series as an RRULE, e.g. FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=10 (weekly only, interval 1 or 2). Kept in the workspace time zone."),
    },
  }, tool(async (x: { title?: string; startsAt?: string; durationMin?: number; sourceType?: "thread" | "task" | "contact"; sourceId?: string; invitees?: string[]; sendInvites?: boolean; agentId?: string; repeats?: string }) => {
    writable();
    let who: SuiteActor = a;
    if (x.sendInvites) {
      const id = actor.agentId ?? x.agentId;
      if (!id) throw new HttpError(422, "agent_required", "Pass agentId: invites go out as an agent inbox.");
      if (actor.agentId && x.agentId && x.agentId !== actor.agentId) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
      const ag = await getAgent(deps, actor.orgId, id);
      who = { ...a, agentId: ag.id, name: ag.name };
    }
    const r = await createMeeting(deps, who, { title: x.title, startsAt: x.startsAt, durationMin: x.durationMin, invitees: x.invitees, sendInvites: x.sendInvites, recurrence: x.repeats, source: x.sourceType && x.sourceId ? { type: x.sourceType, id: x.sourceId } : undefined });
    return { meeting: { id: r.meeting.id, title: r.meeting.title, startsAt: r.meeting.startsAt, guestUrl: r.meeting.guestUrl, invitees: r.meeting.invitees, videoEnabled: r.meeting.videoEnabled, repeats: r.meeting.recurrence?.summary ?? null }, invites: r.invites };
  }));
}


/** Custom fields, guests and the portfolio. A guest invite from an agent follows its approval rules. */
function registerR8Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const a = actor as unknown as SuiteActor;
  const fieldTypes = z.enum(["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url", "formula", "rollup"]);

  server.registerTool("list_custom_fields", {
    title: "List a project's custom fields", annotations: ro,
    description: "The custom fields on a project with their type and, for select fields, their options (id and label). Currency is AUD.",
    inputSchema: { projectId: z.string() },
  }, tool(async (x: { projectId: string }) => ({ fields: await listFields(deps, a.orgId, x.projectId) })));

  server.registerTool("create_custom_field", {
    title: "Add a custom field to a project", annotations: rw,
    description: "Types: text, number, currency (AUD), date, select, multiselect, person, checkbox, url, formula, rollup. Select types take option labels. A formula takes config { expression } (like {Budget} * 1.1); a rollup takes config { source, fn, field } (create_formula_field and create_rollup_field explain both).",
    inputSchema: {
      projectId: z.string(), name: z.string().min(1).max(60), type: fieldTypes, options: z.array(z.string().max(60)).max(50).optional(),
      config: z.object({ expression: z.string().max(500).optional(), source: z.string().max(20).optional(), fn: z.string().max(20).optional(), field: z.string().max(64).optional() }).optional(),
    },
  }, tool(async (x: { projectId: string; name: string; type: z.infer<typeof fieldTypes>; options?: string[]; config?: Record<string, string | undefined> }) => {
    writable();
    const config = x.type === "rollup" ? { ...x.config, field: x.config?.field ?? null } : x.config;
    return { field: await createField(deps, a, x.projectId, { name: x.name, type: x.type, options: x.options?.map((label) => ({ label })), config }) };
  }));

  server.registerTool("set_task_fields", {
    title: "Set custom field values on a task", annotations: rw,
    description: "values maps a field id or field name to a value. Text and URL: string. Number and currency (AUD): number. Date: YYYY-MM-DD. Select: option label or id. Multi select: list of labels. Person: member:<id> or agent:<id>. Checkbox: true or false. null clears.",
    inputSchema: { taskId: z.string(), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])) },
  }, tool(async (x: { taskId: string; values: Record<string, unknown> }) => {
    writable();
    const t = await updateTask(deps, a, x.taskId, { fields: x.values });
    return { ref: t.ref, fields: t.fields };
  }));

  server.registerTool("find_tasks_by_field", {
    title: "Find tasks by a custom field", annotations: ro,
    description: "Tasks in a project whose field matches. op is eq, ne, gt, gte, lt, lte, contains, empty or notempty. Optionally sort by a field.",
    inputSchema: { projectId: z.string(), fieldId: z.string(), op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "empty", "notempty"]).optional(), value: z.string().optional(), sortBy: z.string().optional(), desc: z.boolean().optional() },
  }, tool(async (x: { projectId: string; fieldId: string; op?: FilterOp; value?: string; sortBy?: string; desc?: boolean }) => {
    const list = await listTasks(deps, a, { projectId: x.projectId, fieldFilters: [{ fieldId: x.fieldId, op: x.op ?? "eq", value: x.value }], sort: x.sortBy ? `field:${x.sortBy}` : undefined, dir: x.desc ? "desc" : "asc" });
    return { tasks: list.map((t) => ({ id: t.id, ref: t.ref, title: t.title, status: t.statusName, fields: t.fields })) };
  }));

  server.registerTool("list_guests", {
    title: "List a project's guests", annotations: ro,
    description: "Outside people (clients) invited to a project, with their status.",
    inputSchema: { projectId: z.string() },
  }, tool(async (x: { projectId: string }) => ({ guests: await listGuests(deps, a.orgId, x.projectId) })));

  server.registerTool("invite_guest", {
    title: "Invite a guest to a project", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description: "Invite an outside person by email to one project. Guests are free and see only that project's tasks, comments and docs. The invite email goes from this agent's inbox and follows its approval rules, so it may wait for a person to approve it.",
    inputSchema: { projectId: z.string(), email: z.string().email(), name: z.string().max(80).optional() },
  }, tool(async (x: { projectId: string; email: string; name?: string }) => {
    writable();
    if (!a.agentId) throw new HttpError(422, "agent_required", "Guest invites from MCP go out as an agent. Use an agent key.");
    const r = await inviteGuest(deps, a, x.projectId, x);
    return { guest: r.guest, delivery: r.delivery };
  }));

  server.registerTool("get_portfolio", {
    title: "Portfolio of all projects", annotations: ro,
    description: "Every project with owner, progress (percent done), overdue count, time logged, next due date and the health flag set by people (on_track, at_risk, off_track).",
  }, tool(async () => ({ projects: await portfolio(deps, a.orgId) })));

  server.registerTool("set_project_health", {
    title: "Set a project's health", annotations: rw,
    description: "Set the health flag on the portfolio: on_track, at_risk, off_track, or null to clear, with an optional short note.",
    inputSchema: { projectId: z.string(), health: z.enum(["on_track", "at_risk", "off_track"]).nullable(), note: z.string().max(500).optional() },
  }, tool(async (x: { projectId: string; health: "on_track" | "at_risk" | "off_track" | null; note?: string }) => {
    writable();
    const p = await updateProject(deps, a, x.projectId, { health: x.health, ...(x.note !== undefined ? { healthNote: x.note } : {}) });
    return { project: { id: p.id, name: p.name, health: p.health, healthNote: p.healthNote } };
  }));
}

/** Chat, templates and goals. Agents read and post in public channels; DMs and private channels are only for people. */
function registerR10Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const a = actor as unknown as SuiteActor;

  server.registerTool("list_channels", {
    title: "List chat channels", annotations: ro,
    description: "Public chat channels in the workspace with their topic and last message.",
  }, tool(async () => ({ channels: (await listChannels(deps, a)).map((c) => ({ id: c.id, name: c.name, topic: c.topic, lastMessage: c.lastMessage, lastMessageAt: c.lastMessageAt })) })));

  server.registerTool("read_channel", {
    title: "Read a chat channel", annotations: ro,
    description: "Recent top level messages in a channel, oldest first, with mentions, links, attachments and reply counts. Pass since (ISO time) to get only newer or changed messages.",
    inputSchema: { channelId: z.string(), limit: z.number().int().min(1).max(100).optional(), since: z.string().optional() },
  }, tool(async (x: { channelId: string; limit?: number; since?: string }) => channelMessages(deps, a, x.channelId, { limit: x.limit ?? 30, since: x.since })));

  server.registerTool("read_chat_thread", {
    title: "Read a chat thread", annotations: ro,
    description: "A top level chat message and all its replies.",
    inputSchema: { messageId: z.string() },
  }, tool(async (x: { messageId: string }) => getThread(deps, a, x.messageId)));

  server.registerTool("post_message", {
    title: "Post in a chat channel", annotations: rw,
    description: "Post a message in a public channel, or reply in a thread with parentId. Mention a person with <@member:USER_ID> (ids from list_assignees or get_task), link a task with <#task:ID> or an email thread with <#thread:ID>. Chat stays inside the workspace, so it needs no approval.",
    inputSchema: { channelId: z.string(), body: z.string().min(1).max(20_000), parentId: z.string().optional() },
  }, tool(async (x: { channelId: string; body: string; parentId?: string }) => { writable(); return { message: await postMessage(deps, a, x.channelId, { body: x.body, parentId: x.parentId }) }; }));

  server.registerTool("message_to_task", {
    title: "Turn a chat message into a task", annotations: rw,
    description: "Make a task from a chat message. The task links back to the message and the message shows the task. Set triage: true to send it to the Triage queue instead.",
    inputSchema: { messageId: z.string(), title: z.string().max(300).optional(), projectId: z.string().optional(), assignee: z.string().optional(), triage: z.boolean().optional() },
  }, tool(async (x: { messageId: string; title?: string; projectId?: string; assignee?: string; triage?: boolean }) => {
    writable();
    const t = await messageToTask(deps, a, x.messageId, { title: x.title, projectId: x.projectId, assignee: x.triage ? undefined : parseAssignee(x.assignee), triage: x.triage });
    return { task: { id: t.id, ref: t.ref, title: t.title } };
  }));

  server.registerTool("list_templates", {
    title: "List project, task and doc templates", annotations: ro,
    description: "Starter templates (client onboarding, content calendar, sales pipeline, bug tracker, meeting notes, project brief) and the workspace's saved ones.",
  }, tool(async () => ({ templates: await listTemplates(deps, a.orgId) })));

  server.registerTool("use_template", {
    title: "Make a project, task or doc from a template", annotations: rw,
    description: "Creates a project (statuses, custom fields, tasks with due dates from startDate), a task in projectId for a task template, or a doc for a doc template.",
    inputSchema: { templateId: z.string(), name: z.string().max(120).optional(), projectId: z.string().optional(), startDate: z.string().optional() },
  }, tool(async (x: { templateId: string; name?: string; projectId?: string; startDate?: string }) => { writable(); return useTemplate(deps, a, x.templateId, x); }));

  server.registerTool("pin_message", {
    title: "Pin or unpin a chat message", annotations: rw,
    description: "Pins a top level chat message to the top of its channel (pinned: true) or unpins it (pinned: false). Use it for a channel's welcome, rules or key links.",
    inputSchema: { messageId: z.string(), pinned: z.boolean().default(true) },
  }, tool(async (x: { messageId: string; pinned?: boolean }) => { writable(); return { message: await pinMessage(deps, a, x.messageId, x.pinned ?? true) }; }));

  server.registerTool("create_template", {
    title: "Create a template from scratch", annotations: rw,
    description: "kind project: data { project: { name, description? }, tasks: [{ title, notes?, priority?, dueInDays?, subtasks? }] }. kind task: data { title, notes?, subtasks? }. kind doc: data { title, text } with one paragraph per line, # headings and - bullets.",
    inputSchema: { kind: z.enum(["project", "task", "doc"]), name: z.string().max(120).optional(), description: z.string().max(500).optional(), data: z.record(z.string(), z.unknown()) },
  }, tool(async (x: { kind: TemplateKind; name?: string; description?: string; data: Record<string, unknown> }) => { writable(); return { template: await saveTemplate(deps, a, x) }; }));

  server.registerTool("set_task_repeat", {
    title: "Make a task repeat", annotations: rw,
    description: "freq daily, weekly, monthly or yearly; interval for every N; weekdays (0 Sunday to 6 Saturday) for weekly; monthDay for monthly; until YYYY-MM-DD. Finishing the task makes the next one. Pass freq none to stop.",
    inputSchema: { taskId: z.string(), freq: z.enum(["daily", "weekly", "monthly", "yearly", "none"]), interval: z.number().int().min(1).max(365).optional(), weekdays: z.array(z.number().int().min(0).max(6)).optional(), monthDay: z.number().int().min(1).max(31).optional(), until: z.string().optional() },
  }, tool(async (x: { taskId: string; freq: "daily" | "weekly" | "monthly" | "yearly" | "none"; interval?: number; weekdays?: number[]; monthDay?: number; until?: string }) => {
    writable();
    const t = await updateTask(deps, a, x.taskId, { repeat: x.freq === "none" ? null : { freq: x.freq, interval: x.interval, weekdays: x.weekdays, monthDay: x.monthDay, until: x.until } });
    return { ref: t.ref, repeat: t.repeat };
  }));

  server.registerTool("list_goals", {
    title: "Goals and key results", annotations: ro,
    description: "Every goal with its key results, progress (0 to 100, from numbers and linked tasks, rolled up through child goals), health and a summary.",
  }, tool(async () => goalTree(deps, a.orgId)));

  server.registerTool("create_goal", {
    title: "Create a goal", annotations: rw,
    description: "A goal with optional key results. Key result kinds: number, currency (AUD), percent (start, target, current) or tasks (taskIds or projectId).",
    inputSchema: {
      name: z.string().min(1).max(200), description: z.string().max(5000).optional(), parentId: z.string().optional(), due: z.string().optional(),
      keyResults: z.array(z.object({ name: z.string(), kind: z.enum(["number", "currency", "percent", "tasks"]).optional(), start: z.number().optional(), target: z.number().optional(), current: z.number().optional(), projectId: z.string().optional(), taskIds: z.array(z.string()).optional() })).max(20).optional(),
    },
  }, tool(async (x: Parameters<typeof createGoal>[2]) => { writable(); return { goal: await createGoal(deps, a, x) }; }));

  server.registerTool("update_key_result", {
    title: "Record progress on a key result", annotations: rw,
    description: "Set current (and optionally target) on a number, currency or percent key result, or replace the linked taskIds on a tasks key result.",
    inputSchema: { keyResultId: z.string(), current: z.number().optional(), target: z.number().optional(), taskIds: z.array(z.string()).optional() },
  }, tool(async (x: { keyResultId: string; current?: number; target?: number; taskIds?: string[] }) => { writable(); return { keyResult: await updateKeyResult(deps, a, x.keyResultId, x) }; }));

  server.registerTool("list_notifications", {
    title: "Your notifications", annotations: ro,
    description: "The notifications inbox of the person who made this key (workspace keys only): mentions, assignments, comments, approvals and due-soon items.",
    inputSchema: { unread: z.boolean().optional(), category: z.enum(["mention", "assignment", "comment", "approval", "due_soon", "chat", "email", "status"]).optional() },
  }, tool(async (x: { unread?: boolean; category?: string }) => {
    if (a.agentId || !a.userId) throw new HttpError(403, "workspace_key_only", "Agent keys have no notifications inbox. Use a workspace key.");
    return listNotifications(deps, a.orgId, a.userId, { unread: x.unread, category: x.category, limit: 50 });
  }));
}

/** Integrations and scheduling. */
function registerR11Tools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const a = actor as unknown as SuiteActor;

  server.registerTool("list_integrations", {
    title: "List integrations", annotations: ro,
    description: "The connector catalogue (Slack, Discord, Teams, Zapier, Make, n8n, Google Sheets, any URL), the connected integrations, and the incoming webhooks with their last calls.",
  }, tool(async () => {
    const { listIntegrations, listIncomingHooks } = await import("../services/suite/integrations");
    const { catalogue, connections } = await listIntegrations(deps, a.orgId);
    return { catalogue: catalogue.map((c) => ({ id: c.id, name: c.name, format: c.format, events: c.events })), connections, incomingHooks: await listIncomingHooks(deps, a.orgId) };
  }));

  server.registerTool("create_incoming_hook", {
    title: "Create an incoming webhook", annotations: rw,
    description: "Makes a secret URL that turns a JSON or form POST into a task (title, notes, due, assignee email), a chat message in a channel, or a contact. The URL is returned once.",
    inputSchema: { name: z.string().min(1).max(80), action: z.enum(["task", "chat", "contact"]), projectId: z.string().optional(), channelId: z.string().optional(), mapping: z.record(z.string(), z.string()).optional() },
  }, tool(async (x: { name: string; action: "task" | "chat" | "contact"; projectId?: string; channelId?: string; mapping?: Record<string, string> }) => {
    writable();
    const { createIncomingHook } = await import("../services/suite/integrations");
    return createIncomingHook(deps, a, { name: x.name, action: x.action, config: { projectId: x.projectId, channelId: x.channelId, mapping: x.mapping } });
  }));
  if (deps.config.schedulingEnabled) {
    server.registerTool("list_bookings", {
      title: "List meeting bookings", annotations: ro,
      description: "Bookings made through the workspace's public booking pages, with time, guest name and email, status and the meeting.",
      inputSchema: { upcoming: z.boolean().optional(), status: z.enum(["confirmed", "cancelled"]).optional() },
    }, tool(async (x: { upcoming?: boolean; status?: "confirmed" | "cancelled" }) => {
      const { listBookings } = await import("../services/suite/scheduling");
      return { bookings: await listBookings(deps, a, { upcoming: x.upcoming ?? true, status: x.status }) };
    }));
  }
}

/** Round 20: react to a chat message (write keys only; keys see public channels only). */
function registerR20ChatTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const a = actor as unknown as SuiteActor;
  server.registerTool("react_to_chat_message", {
    title: "React to a chat message", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: "Adds an emoji reaction to a chat message or thread reply in a public channel, or takes it off when this key already reacted with that emoji. Send one emoji character. The answer has the message's reactions with counts.",
    inputSchema: { messageId: z.string(), emoji: z.string().min(1).max(32) },
  }, tool(async (x: { messageId: string; emoji: string }) => {
    writable();
    const { toggleReaction } = await import("../services/suite/chat-reactions");
    return toggleReaction(deps, a, x.messageId, x.emoji);
  }));
}
