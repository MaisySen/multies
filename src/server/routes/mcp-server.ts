/**
 * The MCP server: MyMail's agent tools for Claude, ChatGPT, Cursor and any MCP client.
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
import { listMailboxes } from "../services/addresses";
import type { SuiteActor } from "../services/suite/common";
import { addComment, createTask, createTaskFromThread, listProjects, listTasks, nextTaskFor, parseAssignee, taskDetail, updateTask } from "../services/suite/tasks";
import { appendToDoc, createDoc, getDoc, listDocs } from "../services/suite/docs";
import { contactDetail, listContacts, upsertContact } from "../services/suite/contacts";
import {
  createAgent, eventsSince, getAgent, latestEventSeq, listAgents, listThreads, readThread, replyInThread, requestSend, scopeFor, searchMessages, type Actor,
} from "../services/agents";

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
  const server = new McpServer({ name: "mymail", title: "MyMail", version: deps.config.release, websiteUrl: origin },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator(), instructions: actor.agentId
      ? "You are connected as one MyMail agent inbox. Read threads, search, send or reply as this agent, and pick up tasks assigned to you (next_task), comment on them and mark them done. Sends may wait for a person to approve them; the result says so."
      : "You are connected to a MyMail workspace. List inboxes, read and search mail, create agent inboxes, send or reply as an agent (pass agentId), and work with tasks, projects, docs and contacts." });
  const writable = () => { if (actor.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read."); };
  const agentFor = async (agentId?: string) => {
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
      mailboxes: boxes.map((m) => ({ mailboxId: m.id, address: m.address, name: m.displayName })),
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

  if (!actor.agentId) {
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
  }

  registerSuiteTools(server, deps, actor, writable);
  return server;
}

/** Tasks, projects, docs and contacts. Internal work: no approval needed. Mail sends keep their rules. */
function registerSuiteTools(server: McpServer, deps: Deps, actor: Scoped, writable: () => void) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const a = actor as unknown as SuiteActor;
  const assigneeArg = z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional().describe("member:<userId> or agent:<agentId>. Use \"me\" in list_tasks for your own.");
  const lite = (t: Awaited<ReturnType<typeof listTasks>>[number]) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status, statusName: t.statusName, priority: t.priority, due: t.due, assignee: t.assignee?.name ?? null, labels: t.labels, threadId: t.source?.threadId ?? null, subtasks: t.subtasks });

  server.registerTool("list_tasks", {
    title: "List tasks", annotations: ro,
    description: "Tasks in the workspace, filtered. assignee takes me, none, member:<id> or agent:<id>. Returns short rows; call get_task for the thread and comments.",
    inputSchema: {
      projectId: z.string().optional(), status: z.enum(["todo", "doing", "done"]).optional(), assignee: z.string().optional(),
      priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(), label: z.string().optional(), q: z.string().max(200).optional(),
      threadId: z.string().optional().describe("Tasks made from this email thread."), limit: z.number().int().min(1).max(200).default(50),
    },
  }, tool(async (x: { projectId?: string; status?: "todo" | "doing" | "done"; assignee?: string; priority?: "none" | "low" | "medium" | "high" | "urgent"; label?: string; q?: string; threadId?: string; limit: number }) =>
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
    },
  }, tool(async (x: { title?: string; notes?: string; projectId?: string; status?: "todo" | "doing" | "done"; assignee?: string | null; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string; labels?: string[]; parentId?: string; messageId?: string; threadId?: string }) => {
    writable();
    const assignee = parseAssignee(x.assignee);
    if (x.messageId || x.threadId) return { task: await createTaskFromThread(deps, a, { ...x, assignee }) };
    if (!x.title) throw new HttpError(422, "validation_failed", "Give the task a title, or pass messageId to make it from an email.");
    return { task: await createTask(deps, a, { ...x, title: x.title, assignee }) };
  }));

  server.registerTool("update_task", {
    title: "Update a task", annotations: rw,
    description: "Change a task: status (todo, doing, done) or a project status id, assignee, priority, due date, labels, title or notes.",
    inputSchema: {
      id: z.string(), title: z.string().max(300).optional(), notes: z.string().max(50_000).optional(), status: z.enum(["todo", "doing", "done"]).optional(), statusId: z.string().optional(),
      assignee: assigneeArg, priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(), due: z.string().nullable().optional(), labels: z.array(z.string()).max(20).optional(),
    },
  }, tool(async (x: { id: string; title?: string; notes?: string; status?: "todo" | "doing" | "done"; statusId?: string; assignee?: string | null; priority?: "none" | "low" | "medium" | "high" | "urgent"; due?: string | null; labels?: string[] }) => {
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
