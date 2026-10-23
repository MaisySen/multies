/**
 * The MCP server: MyMail's agent tools for Claude, ChatGPT, Cursor and any MCP client.
 * Streamable HTTP, stateless: each request builds a server bound to the caller's API key,
 * so an agent key only ever sees and sends as its own agent.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import type { AppEnv, Deps } from "../context";
import { HttpError } from "../lib/errors";
import { listMailboxes } from "../services/addresses";
import {
  createAgent, eventsSince, getAgent, latestEventSeq, listAgents, listThreads, readThread, replyInThread, requestSend, scopeFor, searchMessages, type Actor,
} from "../services/agents";

type Scoped = Actor & { scope?: "full" | "read" };

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
      ? "You are connected as one MyMail agent inbox. Read threads, search, and send or reply as this agent. Sends may wait for a person to approve them; the result says so."
      : "You are connected to a MyMail workspace. List inboxes, read and search mail, create agent inboxes, and send or reply as an agent (pass agentId)." });
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
  return server;
}

export function registerMcpRoute(api: OpenAPIHono<AppEnv>) {
  api.all("/mcp", async (c) => {
    const base = c.var.auth as Scoped;
    const actor: Scoped = { ...base, sessionId: `mcp:${base.sessionId}` };
    const server = buildMcpServer(c.var.deps, actor, new URL(c.req.url).origin);
    const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c);
    return res ?? c.body(null, 202);
  });
}
