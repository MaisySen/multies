/**
 * Agent inboxes in the public API (v1). Workspace keys manage agents; agent keys
 * (created with an agent) act only as that agent: its inbox, the mailboxes it was given,
 * its events and its own send requests.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { idempotentCreate, idempotentId } from "../lib/idempotency"; // R52 (MB-239)
import { streamSSE } from "hono/streaming";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { apiKeys, attachments, members, messages, oauthGrants } from "../db/schema";
import { HttpError, notFound } from "../lib/errors";
import { splitToolList } from "../lib/api-scopes";
import {
  agentAudit, agentMailboxIdsFor, approveSend, createAgent, createAgentKey, deleteAgent, eventsPage, eventsSince, getAgent, latestEventSeq, listAgentKeys, listAgents,
  listApprovals, listThreads, readThread, rejectSend, replyInThread, requestSend, revokeAgentKey, scopeFor, searchMessages, updateAgent, type Actor,
} from "../services/agents";
import { attachmentBytes } from "../services/mail/store";
import { logMailboxOpen } from "../services/mailbox-sharing-priv1a";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this (an agent key acting outside its agent, or a guardrail)."), 404: err("Not found."), 422: err("Validation failed.") } as const;
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const secured = [{ bearerAuth: [] }];
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "agt_k3j2h1g0f9e8d7c6" }) });

// PRIV1b (P51): "external" means outside this workspace: only a mailbox or alias of the agent's own workspace on a
// verified domain skips approval. Another workspace hosted on the platform waits like any outside address.
// AIS1 (row 4): only a person in the app lowers an agent's approval; a key or a connected AI app gets 403 person_only.
const ApprovalMode = z.enum(["always", "external", "never"]).openapi({ description: "`always`: a person approves every send (the default). `external`: only mail to addresses outside this workspace waits. `never`: sends go straight out. Only a person in the app can choose `external` or `never` or lower it; an API key gets 403 `person_only`." });

const Agent = z.object({
  id: z.string().openapi({ example: "agt_k3j2h1g0f9e8d7c6" }),
  name: z.string().openapi({ example: "Invoice bot" }),
  description: z.string().nullable(),
  address: z.string().email().openapi({ example: "invoices@acme.com.au" }),
  inboxId: z.string().openapi({ description: "The agent's own mailbox id." }),
  approvalMode: ApprovalMode,
  sendCapDaily: z.number().int(),
  allowedRecipients: z.array(z.string()).nullable().openapi({ description: "Addresses or \"@domain\" entries the agent may send to. null means anyone." }),
  status: z.enum(["active", "paused"]),
  mailboxIds: z.array(z.string()).openapi({ description: "Every mailbox the agent can read and send from, its own inbox first." }),
  sentToday: z.number().int(),
  pendingApprovals: z.number().int(),
  createdAt: z.string().datetime(),
}).openapi("Agent");

const Address = z.object({ address: z.string(), name: z.string().optional() });
const AgentMessage = z.object({
  id: z.string(), threadId: z.string(), mailboxId: z.string(), folder: z.string(), direction: z.enum(["inbound", "outbound"]),
  from: Address, to: z.array(Address), cc: z.array(Address), replyTo: z.string().nullable(), subject: z.string(), date: z.string(), isRead: z.boolean(),
  text: z.string(), latestText: z.string().openapi({ description: "The new part of the message: quoted history and signature removed." }), html: z.string().nullable(),
  codes: z.array(z.string()).openapi({ description: "One-time codes found in the message.", example: ["482913"] }),
  links: z.array(z.string()),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string(), sizeBytes: z.number(), url: z.string().nullable() })),
  sentBy: z.object({ type: z.enum(["agent", "person", "external"]), agentId: z.string().optional(), name: z.string().nullable().optional(), userId: z.string().nullable().optional() }),
  auth: z.unknown().nullable(),
}).openapi("AgentMessage");

const Approval = z.object({
  id: z.string().openapi({ example: "apr_2b4d6f8h0j2l4n6p" }), agentId: z.string(), mailboxId: z.string(), threadId: z.string().nullable(),
  status: z.enum(["pending", "sent", "rejected", "failed", "expired"]),
  to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), subject: z.string(), text: z.string(), html: z.string().nullable(), inReplyToId: z.string().nullable(),
  decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), note: z.string().nullable(), messageId: z.string().nullable(), error: z.string().nullable(),
  expiresAt: z.string(), createdAt: z.string(),
}).openapi("Approval");

const Thread = z.object({ id: z.string(), mailboxId: z.string(), subject: z.string(), messageCount: z.number(), messages: z.array(AgentMessage), pendingApprovals: z.array(Approval) }).openapi("Thread");
const ThreadSummary = z.object({
  id: z.string(), mailboxId: z.string(), subject: z.string(), snippet: z.string(), lastMessageAt: z.string(), messageCount: z.number(), unreadCount: z.number(),
  from: Address, lastSentBy: z.object({ type: z.string(), agentId: z.string().optional(), name: z.string().nullable().optional() }),
  agentsInvolved: z.array(z.object({ agentId: z.string(), name: z.string().nullable() })), pendingApprovals: z.number(),
}).openapi("ThreadSummary");

const SendBody = z.object({
  mailboxId: z.string().optional().openapi({ description: "Send from one of the agent's mailboxes. Defaults to its own inbox." }),
  to: z.array(z.string().email()).min(1).max(50).openapi({ example: ["ada@example.com"] }),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(1_000_000).default(""),
  html: z.string().max(2_000_000).optional(),
  inReplyToId: z.string().optional(),
}).openapi("AgentSendRequest");

const SendOutcome = z.object({
  status: z.enum(["sent", "pending_approval"]),
  result: z.object({ messageId: z.string(), internal: z.array(z.string()), external: z.array(z.object({ address: z.string(), status: z.string(), detail: z.string().optional() })) }).optional(),
  approval: Approval.optional(),
}).openapi("AgentSendOutcome");

const Event = z.object({ id: z.number().int(), type: z.string(), agentId: z.string().nullable(), data: z.record(z.string(), z.unknown()), createdAt: z.string() }).openapi("AgentEvent");

/** Dates to ISO strings, the way the JSON response will carry them. */
const ser = (v: unknown) => JSON.parse(JSON.stringify(v)) as never;
const actorOf = (c: { var: { auth: unknown } }) => c.var.auth as Actor;
/** PRIV1b (P47): how often an open event stream re-checks its key, the key's creator and the agent. */
export const STREAM_RECHECK_MS = 30_000;

export function registerAgentRoutes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({ method: "post", path: "/agents", tags: ["Agents"], summary: "Create an agent inbox",
    description: "Creates the agent, its inbox and an agent API key in one call. The key is returned once. Needs a workspace key. A new agent starts safe: a person approves every message (`always`), 100 sends a day and your own verified domains as its allowed recipients. A key can't ask for looser settings (403 `person_only`, naming the field); a person changes them in the app.", security: secured,
    request: body(z.object({
      name: z.string().min(1).max(80).openapi({ example: "Invoice bot" }),
      description: z.string().max(500).optional(),
      localPart: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i).optional().openapi({ description: "The part before the @. Defaults to a slug of the name.", example: "invoices" }),
      domainId: z.string().optional().openapi({ description: "Which of your domains to use. Defaults to your first verified domain." }),
      approvalMode: ApprovalMode.optional(),
      sendCapDaily: z.number().int().min(0).max(100_000).optional().openapi({ description: "Messages a day. Default 100, never above your plan's limit. A key may set 100 or less." }),
      allowedRecipients: z.array(z.string().min(3).max(254)).max(200).nullable().optional().openapi({ description: "Addresses or \"@domain\" entries the agent may send to. Default: your verified domains (with none yet, the key creator's own address). From a key, null or an empty list gets the default too; only a person in the app can let an agent mail anyone." }),
      mailboxIds: z.array(z.string()).max(50).optional().openapi({ description: "Shared mailboxes this agent can also work, for example support@." }),
      createKey: z.boolean().default(true),
    })),
    responses: {
      // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key, ajinabraham.njsscan.generic.hardcoded_secrets.node_secret (OpenAPI schema with a truncated example, no key material)
      201: json(z.object({ agent: Agent, apiKey: z.object({ id: z.string(), prefix: z.string(), secret: z.string().openapi({ example: "mm_live_7Yq2..." }) }).nullable() }), "The agent and, once, its key."),
      401: errors[401], 403: errors[403], 409: err("No domain yet, or the address is taken."), 422: errors[422],
    } }),
  async (c) => c.json(ser(await createAgent(c.var.deps, actorOf(c), c.req.valid("json"), { ...(await idempotentCreate(c.req.raw, "agt")), mailboxId: await idempotentId(c.req.raw, "mbx") })), 201));

  api.openapi(createRoute({ method: "get", path: "/agents", tags: ["Agents"], summary: "List agent inboxes", security: secured,
    responses: { 200: json(z.object({ data: z.array(Agent) }), "Agents. An agent key sees only its own."), 401: errors[401] } }),
  async (c) => {
    const actor = actorOf(c);
    const all = await listAgents(c.var.deps, actor.orgId);
    return c.json(ser({ data: actor.agentId ? all.filter((a) => a.id === actor.agentId) : all }), 200);
  });

  api.openapi(createRoute({ method: "get", path: "/agents/{id}", tags: ["Agents"], summary: "Get an agent inbox", security: secured, request: { params: Id },
    responses: { 200: json(Agent, "The agent."), 401: errors[401], 403: errors[403], 404: errors[404] } }),
  async (c) => {
    const id = c.req.valid("param").id;
    if (actorOf(c).agentId && actorOf(c).agentId !== id) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    return c.json(ser(await getAgent(c.var.deps, actorOf(c).orgId, id)), 200);
  });

  api.openapi(createRoute({ method: "patch", path: "/agents/{id}", tags: ["Agents"], summary: "Update an agent inbox", description: "Change the approval mode, send cap, allowed recipients, shared mailboxes, or pause it. Needs a workspace key. A key can only tighten an agent: raise its approval, lower its cap, narrow its allowed recipients, pause it or take mailboxes away. Loosening any of these, or resuming a paused agent, answers 403 `person_only` naming the fields, changes nothing and is written to the agent's audit log; a person does it in the app. Name and description stay open.", security: secured,
    request: { params: Id, ...body(z.object({
      name: z.string().min(1).max(80).optional(), description: z.string().max(500).nullable().optional(), approvalMode: ApprovalMode.optional(),
      sendCapDaily: z.number().int().min(0).max(100_000).optional(), allowedRecipients: z.array(z.string().min(3).max(254)).max(200).nullable().optional(),
      mailboxIds: z.array(z.string()).max(50).optional(), status: z.enum(["active", "paused"]).optional(),
    })) },
    responses: { 200: json(Agent, "The agent."), 401: errors[401], 403: errors[403], 404: errors[404], 422: errors[422] } }),
  async (c) => c.json(ser(await updateAgent(c.var.deps, actorOf(c), c.req.valid("param").id, c.req.valid("json"))), 200));

  api.openapi(createRoute({ method: "delete", path: "/agents/{id}", tags: ["Agents"], summary: "Delete an agent inbox", description: "Deletes the agent, its inbox and mail, and its keys. Needs a workspace key.", security: secured, request: { params: Id },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) }), "Deleted."), 401: errors[401], 403: errors[403], 404: errors[404] } }),
  async (c) => c.json((await deleteAgent(c.var.deps, actorOf(c), c.req.valid("param").id)) as { id: string; deleted: true }, 200));

  api.openapi(createRoute({ method: "post", path: "/agents/{id}/keys", tags: ["Agents"], summary: "Create another agent key", security: secured,
    request: { params: Id, ...body(z.object({ name: z.string().min(1).max(80).optional() })) },
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret (an OpenAPI schema field name, no key material)
    responses: { 201: json(z.object({ id: z.string(), prefix: z.string(), secret: z.string() }), "The key, shown once."), 401: errors[401], 403: errors[403], 404: errors[404] } }),
  async (c) => {
    const k = await createAgentKey(c.var.deps, actorOf(c), c.req.valid("param").id, c.req.valid("json").name);
    return c.json({ id: k.apiKey.id, prefix: k.apiKey.prefix, secret: k.secret }, 201);
  });

  api.openapi(createRoute({ method: "get", path: "/agents/{id}/keys", tags: ["Agents"], summary: "List an agent's keys", security: secured, request: { params: Id },
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), prefix: z.string(), lastUsedAt: z.string().nullable(), createdAt: z.string() })) }), "Keys (never the secrets)."), 401: errors[401], 403: errors[403] } }),
  async (c) => c.json(ser({ data: (await listAgentKeys(c.var.deps, actorOf(c), c.req.valid("param").id)).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt as unknown as string | null, createdAt: k.createdAt as unknown as string })) }), 200));

  api.openapi(createRoute({ method: "delete", path: "/agents/{id}/keys/{keyId}", tags: ["Agents"], summary: "Revoke an agent key", security: secured,
    request: { params: Id.extend({ keyId: z.string().openapi({ param: { name: "keyId", in: "path" } }) }) },
    responses: { 200: json(z.object({ id: z.string(), revoked: z.literal(true) }), "Revoked."), 401: errors[401], 403: errors[403], 404: errors[404] } }),
  async (c) => c.json((await revokeAgentKey(c.var.deps, actorOf(c), c.req.valid("param").id, c.req.valid("param").keyId)) as { id: string; revoked: true }, 200));

  api.openapi(createRoute({ method: "get", path: "/agents/{id}/threads", tags: ["Agents"], summary: "List an agent's threads", description: "Newest first, across the agent's inbox and shared mailboxes. Pass `before` from `nextCursor` for the next page.", security: secured,
    request: { params: Id, query: z.object({ mailboxId: z.string().optional(), folder: z.enum(["inbox", "sent", "archive", "spam"]).optional(), unread: z.coerce.boolean().optional(), before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: json(z.object({ data: z.array(ThreadSummary), nextCursor: z.string().nullable() }), "Threads."), 401: errors[401], 403: errors[403], 404: errors[404] } }),
  async (c) => {
    const { id } = c.req.valid("param");
    const actor = actorOf(c);
    if (actor.agentId && actor.agentId !== id) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    // PRIV1b (P4): a workspace key listing an agent's threads doesn't see a personal mailbox it doesn't own.
    return c.json(await listThreads(c.var.deps, actor.orgId, await agentMailboxIdsFor(c.var.deps, actor, id), c.req.valid("query")), 200);
  });

  api.openapi(createRoute({ method: "get", path: "/threads/{id}", tags: ["Agents"], summary: "Read a thread as JSON",
    description: "Every message with its new text (quoted history removed), one-time codes, links and attachment URLs, plus any sends waiting for approval. Reads by an agent key are written to the audit log.", security: secured,
    request: { params: Id },
    responses: { 200: json(Thread, "The thread."), 401: errors[401], 404: errors[404] } }),
  async (c) => c.json(ser(await readThread(c.var.deps, actorOf(c), c.req.valid("param").id, new URL(c.req.url).origin, c.req.raw.headers)), 200));

  api.openapi(createRoute({ method: "get", path: "/search", tags: ["Agents"], summary: "Search mail", description: "Subject, sender, recipients and body, in the mailboxes the key can read.", security: secured,
    request: { query: z.object({ q: z.string().min(1).max(200), limit: z.coerce.number().int().min(1).max(100).default(25) }) },
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), threadId: z.string(), mailboxId: z.string(), folder: z.string(), subject: z.string(), snippet: z.string(), from: Address, date: z.string() })) }), "Matches, newest first."), 401: errors[401] } }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json({ data: await searchMessages(c.var.deps, actorOf(c), q.q, q.limit) }, 200);
  });

  api.openapi(createRoute({ method: "post", path: "/agents/{id}/send", tags: ["Agents"], summary: "Send as the agent",
    description: "Checks the agent's allowed recipients, daily cap and the plan's monthly allowance. With approval on, the message waits for a person and the response is `pending_approval`; you get `approval.decided` by webhook or stream.", security: secured,
    request: { params: Id, ...body(SendBody) },
    responses: { 200: json(SendOutcome, "Sent now."), 202: json(SendOutcome, "Waiting for approval."), 401: errors[401], 403: errors[403], 429: err("The agent's daily cap is reached.") } }),
  async (c) => {
    const input = c.req.valid("json");
    const r = await requestSend(c.var.deps, actorOf(c), c.req.valid("param").id, { ...input, to: input.to.map((a) => a.toLowerCase()), cc: input.cc?.map((a) => a.toLowerCase()), bcc: input.bcc?.map((a) => a.toLowerCase()) });
    return c.json(ser(r), r.status === "sent" ? 200 : 202);
  });

  api.openapi(createRoute({ method: "post", path: "/agents/{id}/threads/{threadId}/reply", tags: ["Agents"], summary: "Reply in a thread as the agent", description: "Replies to the last message from the other side, threaded, with a \"Re:\" subject. Same guardrails as send.", security: secured,
    request: { params: Id.extend({ threadId: z.string().openapi({ param: { name: "threadId", in: "path" } }) }), ...body(z.object({ text: z.string().min(1).max(1_000_000), html: z.string().max(2_000_000).optional(), replyAll: z.boolean().default(false) })) },
    responses: { 200: json(SendOutcome, "Sent now."), 202: json(SendOutcome, "Waiting for approval."), 401: errors[401], 403: errors[403], 404: errors[404], 429: err("The agent's daily cap is reached.") } }),
  async (c) => {
    const p = c.req.valid("param");
    const r = await replyInThread(c.var.deps, actorOf(c), p.id, p.threadId, c.req.valid("json"));
    return c.json(ser(r), r.status === "sent" ? 200 : 202);
  });

  api.openapi(createRoute({ method: "get", path: "/approvals", tags: ["Approvals"], summary: "List send approvals", description: "An agent key sees its own requests.", security: secured,
    request: { query: z.object({ status: z.enum(["pending", "sent", "rejected", "failed", "expired"]).optional(), agentId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    responses: { 200: json(z.object({ data: z.array(Approval) }), "Approvals, newest first."), 401: errors[401] } }),
  async (c) => c.json(ser({ data: await listApprovals(c.var.deps, actorOf(c), c.req.valid("query")) }), 200));

  api.openapi(createRoute({ method: "post", path: "/approvals/{id}/approve", tags: ["Approvals"], summary: "Approve and send", description: "Approving sends the agent's mail, so a person does it in the app (Approvals). An API key gets 403: `person_only` for a workspace key, `agent_key_scope` for an agent key. Keys can list and reject. Optional edits to the subject or text.", security: secured,
    request: { params: Id, ...body(z.object({ subject: z.string().max(998).optional(), text: z.string().max(1_000_000).optional() })) },
    responses: { 200: json(z.object({ approval: Approval }), "Sent."), 401: errors[401], 403: errors[403], 404: errors[404], 409: err("Already decided or expired.") } }),
  async (c) => c.json(ser({ approval: (await approveSend(c.var.deps, actorOf(c), c.req.valid("param").id, c.req.valid("json"))).approval }), 200));

  api.openapi(createRoute({ method: "post", path: "/approvals/{id}/reject", tags: ["Approvals"], summary: "Reject", description: "Nothing is sent. A workspace key may reject; an agent key can't decide its own requests.", security: secured,
    request: { params: Id, ...body(z.object({ note: z.string().max(1000).optional() })) },
    responses: { 200: json(z.object({ approval: Approval }), "Rejected."), 401: errors[401], 403: errors[403], 404: errors[404], 409: err("Already decided or expired.") } }),
  async (c) => c.json(ser({ approval: await rejectSend(c.var.deps, actorOf(c), c.req.valid("param").id, c.req.valid("json").note) }), 200));

  api.openapi(createRoute({ method: "get", path: "/events", tags: ["Events"], summary: "Poll events",
    description: "Events after `after` (an event id), oldest first: message.received (parsed), message.sent, approval.requested, approval.decided. Keep the last id you saw and pass it next time. An agent key sees its own agent's events.", security: secured,
    request: { query: z.object({ after: z.coerce.number().int().min(0).default(0), agentId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) },
    responses: { 200: json(z.object({ data: z.array(Event) }), "Events."), 401: errors[401] } }),
  async (c) => c.json(ser({ data: await eventsSince(c.var.deps, actorOf(c), c.req.valid("query")) }), 200));

  api.openapi(createRoute({ method: "get", path: "/agents/{id}/events/stream", tags: ["Events"], summary: "Stream events (Server-Sent Events)",
    description: "A live stream of the agent's events as SSE. Each event's `id` is its sequence number: reconnect with the `Last-Event-ID` header (any SSE client does this) to resume without gaps. The server closes the stream after `timeout` seconds (default 300); reconnect then.", security: secured,
    request: { params: Id, query: z.object({ timeout: z.coerce.number().int().min(0).max(900).default(300), from: z.enum(["now", "start"]).default("now") }) },
    responses: { 200: { description: "text/event-stream", content: { "text/event-stream": { schema: z.string() } } }, 401: errors[401], 403: errors[403], 404: errors[404] } }),
  (async (c: Context<AppEnv>) => {
    const deps = c.var.deps;
    const actor = actorOf(c);
    const id = c.req.param("id")!;
    if (actor.agentId && actor.agentId !== id) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    await getAgent(deps, actor.orgId, id);
    const q = new URL(c.req.url).searchParams;
    const timeout = Math.min(900, Math.max(0, Number(q.get("timeout") ?? 300) || 0)) * 1000;
    const resume = Number(c.req.header("last-event-id") ?? "");
    let after = Number.isFinite(resume) && resume > 0 ? resume : q.get("from") === "start" ? 0 : await latestEventSeq(deps, actor.orgId);
    c.header("cache-control", "no-store");
    // PRIV1b (P47): the actor was resolved once, but a stream runs up to 15 minutes. Every 30 seconds it checks the key
    // still exists (revoking deletes it), its creator is still a member and the agent is still there; else it ends.
    // Each message event is also checked against the caller's scope at that moment (eventsPage).
    // PRIV1b (SSE1): the key (or OAuth grant) part runs again before every write of events, so nothing more is sent
    // once it is revoked, its scope changed or its creator left. An idle stream reads nothing extra.
    const was = (actor as { scope?: string }).scope;
    const sameScope = (now: string) => was === undefined || now === was;
    const keyValid = async () => {
      const grantId = actor.apiKeyId?.startsWith("oauth:") ? actor.apiKeyId.slice(6) : null;
      if (grantId) {
        const g = await deps.db.select({ revokedAt: oauthGrants.revokedAt, scope: oauthGrants.scope, member: members.id }).from(oauthGrants)
          .leftJoin(members, and(eq(members.userId, oauthGrants.userId), eq(members.organizationId, oauthGrants.orgId)))
          .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.orgId, actor.orgId))).get();
        return !!g && !g.revokedAt && !!g.member && sameScope(g.scope);
      }
      if (!actor.apiKeyId) return true;
      const k = await deps.db.select({ id: apiKeys.id, scope: apiKeys.scope, member: members.id }).from(apiKeys)
        .leftJoin(members, and(eq(members.userId, apiKeys.createdByUserId), eq(members.organizationId, apiKeys.orgId)))
        .where(and(eq(apiKeys.id, actor.apiKeyId), eq(apiKeys.orgId, actor.orgId))).get();
      return !!k && !(actor.userId && !k.member) && sameScope(splitToolList(k.scope).scope);
    };
    const stillValid = async () => (await keyValid()) && getAgent(deps, actor.orgId, id).then(() => true, () => false);
    return streamSSE(c, async (stream) => {
      const started = Date.now();
      let lastBeat = Date.now();
      let lastCheck = Date.now();
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ agentId: id, after }) });
      while (!stream.aborted) {
        if (Date.now() - lastCheck >= STREAM_RECHECK_MS) {
          if (!(await stillValid())) break;
          lastCheck = Date.now();
        }
        // The caller's own scope, not the agent's: a workspace key watching an agent sees only mail it may open.
        const page = await eventsPage(deps, actor, { after, agentId: id, limit: 100 });
        if (page.events.length && !(await keyValid())) break;
        for (const e of page.events) await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
        after = Math.max(after, page.last);
        const events = page.events;
        if (Date.now() - started >= timeout) break;
        if (Date.now() - lastBeat > 15_000) { await stream.write(": keep-alive\n\n"); lastBeat = Date.now(); }
        await stream.sleep(events.length ? 200 : 2000);
      }
    });
  }) as never);

  api.openapi(createRoute({ method: "get", path: "/agents/{id}/audit", tags: ["Agents"], summary: "An agent's audit log", description: "Everything the agent did and every decision people made on it, newest first. Needs a workspace key.", security: secured,
    request: { params: Id, query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: json(z.object({ data: z.array(z.object({ id: z.string(), action: z.string(), actorEmail: z.string().nullable(), targetType: z.string().nullable(), targetId: z.string().nullable(), metadata: z.unknown(), createdAt: z.string() })) }), "Entries."), 401: errors[401], 403: errors[403] } }),
  async (c) => {
    const actor = actorOf(c);
    if (actor.agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can't read the audit log.");
    const rows = await agentAudit(c.var.deps, actor, c.req.valid("param").id, c.req.valid("query").limit);
    return c.json(ser({ data: rows.map((r) => ({ id: r.id, action: r.action, actorEmail: r.actorEmail, targetType: r.targetType, targetId: r.targetId, metadata: r.metadata, createdAt: r.createdAt as unknown as string })) }), 200);
  });

  api.openapi(createRoute({ method: "get", path: "/attachments/{id}", tags: ["Agents"], summary: "Download an attachment", security: secured, request: { params: Id },
    responses: { 200: { description: "The file." }, 401: errors[401], 404: errors[404] } }),
  (async (c: Context<AppEnv>) => {
    const actor = actorOf(c);
    const scope = await scopeFor(c.var.deps, actor);
    const r = await c.var.deps.db.select({ a: attachments, mailboxId: messages.mailboxId, threadId: messages.threadId }).from(attachments).innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(eq(attachments.id, c.req.param("id")!), eq(messages.orgId, actor.orgId))).get();
    const bytes = r && (!scope || scope.includes(r.mailboxId)) ? await attachmentBytes(r.a, c.var.deps.bodyStore) : null;
    if (!r || !bytes) throw notFound("Attachment");
    // PRIV1b (P17): like the app download, a delegate's key leaves a row in "Who opened my mailbox".
    await logMailboxOpen(c.var.deps, actor, r.mailboxId, "opened_thread", r.threadId, c.req.raw.headers);
    // The sender chose this type, so it is only passed on when it is a plain type token, and the
    // file is always a sandboxed download (an HTML attachment can never run on our origin).
    const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(r.a.contentType) ? r.a.contentType : "application/octet-stream";
    return new Response(bytes as BodyInit, { headers: { "content-type": type, "content-disposition": `attachment; filename="${r.a.filename.replace(/[^\x20-\x7e]|["\\]/g, "_")}"`, "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; sandbox" } });
  }) as never);
}
