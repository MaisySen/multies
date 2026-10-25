/**
 * The public REST API, v1. Routes are declared with @hono/zod-openapi, so the
 * OpenAPI document at /api/v1/openapi.json is generated from the same schemas that
 * validate requests. Interactive reference (Scalar) at /api/v1/reference.
 * Auth: `Authorization: Bearer mm_live_...` (Settings, Developers).
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Context, MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { mailboxes } from "../db/schema";
import { claimFreeAddress } from "../services/free-address";
import { HttpError, unauthorized } from "../lib/errors";
import { idempotency } from "../lib/idempotency";
import { audit } from "../services/audit";
import { createAlias, createMailbox, deleteAlias, deleteMailbox, getMailbox, listAliases, listMailboxes } from "../services/addresses";
import { resolveApiKey } from "../services/developer/api-keys";
import { WEBHOOK_EVENTS, createEndpoint, deleteEndpoint, listEndpoints } from "../services/developer/webhooks";
import { createDomain, getDomain, listDomains, presentDomain, verifyDomain } from "../services/domains";
import { getMessage, getThread, listMessages } from "../services/mail/mailbox-view";
import { sendMessage } from "../services/mail/send";
import { deprovisionMailbox } from "../services/mailserver";
import { registerAgentRoutes } from "./v1-agents";
import { registerMcpRoute } from "./mcp";
import { registerSuiteRoutes } from "./v1-suite";
import { registerSuiteR7Routes } from "./v1-suite-r7";
import { registerSuiteR8Routes } from "./v1-suite-r8";
import { registerSuiteR10Routes } from "./v1-suite-r10";
import { registerSuiteR11Routes } from "./v1-suite-r11";
import { registerPeopleRoutes } from "./v1-people";
import { registerAuthHookRoutes } from "./v1-auth-hooks";

// ---------------------------------------------------------------- schemas

const ErrorSchema = z.object({
  error: z.object({ code: z.string().openapi({ example: "not_found" }), message: z.string().openapi({ example: "Mailbox not found." }), details: z.unknown().optional() }),
}).openapi("Error");

const DnsRecord = z.object({
  id: z.string(), type: z.string(), host: z.string(), value: z.string(), priority: z.number().optional(), purpose: z.string().optional(),
}).passthrough().openapi("DnsRecord");

const Domain = z.object({
  id: z.string().openapi({ example: "dom_k3j2h1g0f9e8d7c6" }),
  name: z.string().openapi({ example: "acme.com" }),
  status: z.enum(["pending", "verified", "failed"]),
  createdAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable(),
  lastCheckedAt: z.string().datetime().nullable(),
  dkimSelector: z.string(),
  catchAllMailboxId: z.string().nullable(),
  records: z.array(DnsRecord).openapi({ description: "The DNS records to publish for this domain." }),
}).openapi("Domain");

const Mailbox = z.object({
  id: z.string().openapi({ example: "mbx_8d7c6b5a4f3e2d1c" }),
  domainId: z.string(),
  address: z.string().email().openapi({ example: "hello@acme.com" }),
  displayName: z.string().openapi({ example: "Acme" }),
  quotaMb: z.number().int(),
  usedBytes: z.number().int(),
  status: z.enum(["active", "suspended"]),
  createdAt: z.string().datetime(),
}).openapi("Mailbox");

const Alias = z.object({
  id: z.string(), domainId: z.string(), address: z.string().email().openapi({ example: "sales@acme.com" }),
  destinations: z.array(z.string().email()), enabled: z.boolean(), createdAt: z.string().datetime(),
}).openapi("Alias");

const Address = z.object({ address: z.string().email(), name: z.string().optional() }).openapi("Address");
const Folder = z.enum(["inbox", "sent", "drafts", "archive", "spam", "trash"]);

const MessageSummary = z.object({
  id: z.string(), mailboxId: z.string(), folder: Folder, threadId: z.string(), from: Address, to: z.array(Address),
  subject: z.string(), snippet: z.string(), date: z.string().datetime(), isRead: z.boolean(), isStarred: z.boolean(), hasAttachments: z.boolean(),
}).openapi("MessageSummary");

const Message = MessageSummary.extend({
  cc: z.array(Address), bcc: z.array(Address), replyTo: z.string().nullable(), text: z.string(), html: z.string().nullable(),
  messageIdHeader: z.string().nullable(), sizeBytes: z.number().int(),
  attachments: z.array(z.object({ id: z.string(), filename: z.string(), contentType: z.string(), sizeBytes: z.number().int(), available: z.boolean() })),
}).openapi("Message");

const SendRequest = z.object({
  mailboxId: z.string().optional().openapi({ description: "The mailbox to send from. Pass this or `from`.", example: "mbx_8d7c6b5a4f3e2d1c" }),
  from: z.string().email().optional().openapi({ description: "The address of the mailbox to send from, instead of mailboxId (for example no-reply@yourdomain.com).", example: "no-reply@example.com" }),
  to: z.array(z.string().email()).min(1).max(50).openapi({ example: ["ada@example.com"] }),
  cc: z.array(z.string().email()).max(50).optional(),
  bcc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(998).default("").openapi({ example: "Your invoice" }),
  text: z.string().max(1_000_000).default("").openapi({ example: "Hi Ada, your invoice is attached." }),
  html: z.string().max(2_000_000).optional(),
  inReplyToId: z.string().optional().openapi({ description: "A message id to reply to; threading headers are set for you." }),
}).openapi("SendRequest");

const SendResult = z.object({
  messageId: z.string(),
  internal: z.array(z.string()).openapi({ description: "Recipients hosted on Multies, delivered directly." }),
  external: z.array(z.object({ address: z.string(), status: z.enum(["sent", "queued", "failed"]), detail: z.string().optional() })),
}).openapi("SendResult");

const WebhookEndpoint = z.object({
  id: z.string(), url: z.string().url(), description: z.string().nullable(), events: z.array(z.string()), enabled: z.boolean(), createdAt: z.string().datetime(),
}).openapi("WebhookEndpoint");

const IdParam = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });

const errors = {
  401: { description: "Missing or invalid API key.", content: { "application/json": { schema: ErrorSchema } } },
  404: { description: "Not found.", content: { "application/json": { schema: ErrorSchema } } },
  422: { description: "The request body or query failed validation.", content: { "application/json": { schema: ErrorSchema } } },
} as const;
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const secured = [{ bearerAuth: [] }];

// ---------------------------------------------------------------- auth

const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await resolveApiKey(c.var.deps, c.req.header("authorization"));
  if (!auth) throw unauthorized("Send an API key: Authorization: Bearer mm_live_...");
  // MCP speaks JSON-RPC over POST; its write tools check the key's scope themselves.
  if (auth.scope === "read" && c.req.method !== "GET" && !c.req.path.endsWith("/mcp")) throw new HttpError(403, "read_only_key", "This API key can only read.");
  if (auth.orgSuspended) throw new HttpError(403, "workspace_suspended", "This workspace is suspended. Contact support to review it.");
  c.set("auth", auth);
  await next();
};

/** Agent keys act only as their agent: the workspace resources need a workspace key. */
const workspaceKeyOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if ((c.var.auth as { agentId?: string | null }).agentId) throw new HttpError(403, "agent_key_scope", "Agent keys can only use the agent endpoints (/agents, /threads, /search, /events, /mcp). Use a workspace key for this.");
  memberKeyCheck(c);
  await next();
};

/** An AI agent member's key acts with the member role: it can't run the workspace's mail, agents or integrations. */
const memberKeyCheck = (c: Context<AppEnv>) => {
  if (c.var.auth.role === "member") throw new HttpError(403, "agent_member_key_scope", "An agent member's key works with tasks, projects, docs, chat, meetings, goals and people. Use a workspace key for this.");
};
const memberKeyReadOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET") memberKeyCheck(c);
  await next();
};

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------- routes

/** Context the parent app set for a request it hands to the lazily built v1 app (see app.ts). */
export const v1ParentVars = new WeakMap<Request, { deps: AppEnv["Variables"]["deps"]; ip: string; requestId: string; log: AppEnv["Variables"]["log"] }>();

export function v1Routes() {
  const api = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        return c.json({ error: { code: "validation_failed", message: issues[0]?.message ?? "Invalid request.", details: issues } }, 422);
      }
    },
  });
  api.use("*", async (c, next) => {
    const parent = v1ParentVars.get(c.req.raw);
    if (parent) {
      c.set("deps", parent.deps);
      c.set("ip", parent.ip);
      c.set("requestId", parent.requestId);
      c.set("log", parent.log);
    }
    await next();
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", description: "An API key from Settings, Developers. Starts with mm_live_." });

  api.doc31("/openapi.json", (c) => ({
    openapi: "3.1.0",
    info: {
      title: "Multies API",
      version: "1.0.0",
      description: "Manage domains, mailboxes and aliases, read mail and send it, give AI agents their own inboxes, and work with tasks, projects, docs, contacts and deals. Agent keys (created with an agent) act only as that agent: they read its threads as JSON and send within its caps and approval rules. The MCP server is at /api/v1/mcp. Webhooks are signed with the Standard Webhooks spec: verify with any Standard Webhooks library and your endpoint's whsec_ secret.",
    },
    servers: [{ url: `${new URL(c.req.url).origin}/api/v1` }],
  }));
  api.get("/reference", Scalar({ url: "/api/v1/openapi.json", pageTitle: "Multies API reference", theme: "default" }));
  // The reference used to live at /api/v1/docs, which is also the docs list. A browser without a key
  // that opens the old address goes to the reference; everything else gets the list.
  api.get("/docs", async (c, next) => {
    if (!c.req.header("authorization") && (c.req.header("accept") ?? "").includes("text/html")) return c.redirect("/api/v1/reference", 301);
    await next();
  });

  // "/x/*" also matches "/x" in Hono, so one registration per resource runs the check once.
  for (const r of ["domains", "mailboxes", "aliases", "messages", "webhooks", "auth-email-hooks"]) api.use(`/${r}/*`, apiKeyAuth, workspaceKeyOnly);
  api.use("/free-address", apiKeyAuth, workspaceKeyOnly);
  for (const r of ["agents", "threads", "search", "approvals", "events", "attachments", "mcp", "tasks", "projects", "docs", "contacts", "companies", "deals", "changes", "time", "forms", "reports", "meetings", "fields", "guests", "portfolio", "chat", "templates", "goals", "key-results", "integrations", "incoming-hooks", "scheduling", "people", "agent-members"]) api.use(`/${r}/*`, apiKeyAuth);
  for (const r of ["agents", "approvals", "integrations", "incoming-hooks"]) api.use(`/${r}/*`, memberKeyReadOnly);
  // Safe retries: an Idempotency-Key header makes POST, PATCH and DELETE replay-safe.
  api.use("*", idempotency((c) => {
    const a = c.var.auth as { apiKeyId?: string } | undefined;
    return a?.apiKeyId ? `key:${a.apiKeyId}` : undefined;
  }));

  const domainOut = (d: Parameters<typeof presentDomain>[0], deps: Parameters<typeof presentDomain>[1]) => {
    const p = presentDomain(d, deps);
    return { id: p.id, name: p.name, status: p.status, createdAt: iso(p.createdAt)!, verifiedAt: iso(p.verifiedAt), lastCheckedAt: iso(p.lastCheckedAt), dkimSelector: p.dkimSelector, catchAllMailboxId: p.catchAllMailboxId, records: p.records as unknown as z.infer<typeof DnsRecord>[] };
  };
  const mailboxOut = (m: Awaited<ReturnType<typeof getMailbox>>) => ({
    id: m.id, domainId: m.domainId, address: m.address, displayName: m.displayName, quotaMb: m.quotaMb, usedBytes: m.usedBytes, status: m.status, createdAt: iso(m.createdAt)!,
  });

  api.openapi(createRoute({ method: "get", path: "/domains", tags: ["Domains"], summary: "List domains", security: secured,
    responses: { 200: json(z.object({ data: z.array(Domain) }), "The workspace's domains."), 401: errors[401] } }),
  async (c) => c.json({ data: (await listDomains(c.var.deps.db, c.var.auth.orgId)).map(({ row }) => domainOut(row, c.var.deps)) }, 200));

  api.openapi(createRoute({ method: "post", path: "/domains", tags: ["Domains"], summary: "Add a domain", description: "Adds the domain, generates its DKIM key and runs a first DNS check.", security: secured,
    request: body(z.object({ name: z.string().min(3).max(253).openapi({ example: "acme.com" }) })),
    responses: { 201: json(Domain, "The new domain with the DNS records to publish."), 401: errors[401], 422: errors[422] } }),
  async (c) => {
    const { name } = c.req.valid("json");
    const { auth, deps } = c.var;
    const d = await createDomain(deps, auth.orgId, name.trim().toLowerCase());
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "domain.added", targetType: "domain", targetId: d.id, metadata: { name: d.name, via: "api" }, ip: c.var.ip });
    await verifyDomain(deps, d);
    return c.json(domainOut(await getDomain(deps.db, auth.orgId, d.id), deps), 201);
  });

  api.openapi(createRoute({ method: "get", path: "/domains/{id}", tags: ["Domains"], summary: "Get a domain", security: secured, request: { params: IdParam },
    responses: { 200: json(Domain, "The domain."), 401: errors[401], 404: errors[404] } }),
  async (c) => c.json(domainOut(await getDomain(c.var.deps.db, c.var.auth.orgId, c.req.valid("param").id), c.var.deps), 200));

  api.openapi(createRoute({ method: "post", path: "/domains/{id}/verify", tags: ["Domains"], summary: "Check DNS now", description: "Runs live DNS lookups for MX, SPF, DKIM and DMARC and updates the status.", security: secured, request: { params: IdParam },
    responses: { 200: json(Domain, "The domain after the check."), 401: errors[401], 404: errors[404] } }),
  async (c) => {
    const { deps, auth } = c.var;
    const d = await getDomain(deps.db, auth.orgId, c.req.valid("param").id);
    await verifyDomain(deps, d);
    return c.json(domainOut(await getDomain(deps.db, auth.orgId, d.id), deps), 200);
  });

  api.openapi(createRoute({ method: "get", path: "/mailboxes", tags: ["Mailboxes"], summary: "List mailboxes", security: secured,
    responses: { 200: json(z.object({ data: z.array(Mailbox) }), "The workspace's mailboxes."), 401: errors[401] } }),
  async (c) => c.json({ data: (await listMailboxes(c.var.deps.db, c.var.auth.orgId)).map(mailboxOut) }, 200));

  api.openapi(createRoute({ method: "post", path: "/mailboxes", tags: ["Mailboxes"], summary: "Create a mailbox", security: secured,
    request: body(z.object({
      domainId: z.string(), localPart: z.string().min(1).max(64).regex(/^[a-z0-9._+-]+$/i).openapi({ example: "hello" }),
      displayName: z.string().min(1).max(100).openapi({ example: "Acme" }), quotaMb: z.number().int().min(50).optional(),
    })),
    responses: { 201: json(Mailbox, "The new mailbox."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => {
    const input = c.req.valid("json");
    const { auth, deps } = c.var;
    const m = await createMailbox(deps.db, auth.orgId, { ...input, localPart: input.localPart.toLowerCase() });
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.created", targetType: "mailbox", targetId: m.id, metadata: { address: m.address, via: "api" }, ip: c.var.ip });
    return c.json(mailboxOut(m), 201);
  });

  api.openapi(createRoute({ method: "post", path: "/free-address", tags: ["Mailboxes"], summary: "Take a free address",
    description: "Creates a mailbox on the shared Multies domain (for example ada.acme@multies.si), with no domain of your own. Send and receive straight away. Free addresses send to fewer people a day than your own domain.",
    security: secured,
    request: body(z.object({ localPart: z.string().min(3).max(40).openapi({ example: "ada.acme" }), displayName: z.string().max(120).optional() })),
    responses: { 201: json(Mailbox, "The new mailbox."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => {
    const input = c.req.valid("json");
    const { auth, deps } = c.var;
    // A workspace key was made by a signed in owner or admin, so the person behind it is known.
    const m = await claimFreeAddress(deps, { ...auth, emailVerified: true }, input);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.created", targetType: "mailbox", targetId: m.id, metadata: { address: m.address, free: true, via: "api" }, ip: c.var.ip });
    return c.json(mailboxOut(m), 201);
  });

  api.openapi(createRoute({ method: "delete", path: "/mailboxes/{id}", tags: ["Mailboxes"], summary: "Delete a mailbox", description: "Deletes the mailbox and all of its mail.", security: secured, request: { params: IdParam },
    responses: { 200: json(z.object({ deleted: z.literal(true) }), "Deleted."), 401: errors[401], 404: errors[404] } }),
  async (c) => {
    const { auth, deps } = c.var;
    const id = c.req.valid("param").id;
    await deprovisionMailbox(deps, auth.orgId, id);
    const m = await deleteMailbox(deps.db, auth.orgId, id);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "mailbox.deleted", targetType: "mailbox", targetId: m.id, metadata: { address: m.address, via: "api" }, ip: c.var.ip });
    return c.json({ deleted: true as const }, 200);
  });

  api.openapi(createRoute({ method: "get", path: "/aliases", tags: ["Aliases"], summary: "List aliases", security: secured,
    responses: { 200: json(z.object({ data: z.array(Alias) }), "The workspace's aliases and forwards."), 401: errors[401] } }),
  async (c) => c.json({ data: (await listAliases(c.var.deps.db, c.var.auth.orgId)).map((a) => ({ id: a.id, domainId: a.domainId, address: a.address, destinations: a.destinations, enabled: a.enabled, createdAt: iso(a.createdAt)! })) }, 200));

  api.openapi(createRoute({ method: "post", path: "/aliases", tags: ["Aliases"], summary: "Create an alias", description: "Forwards an address to mailboxes on Multies or to outside addresses.", security: secured,
    request: body(z.object({ domainId: z.string(), localPart: z.string().min(1).max(64).regex(/^[a-z0-9._+-]+$/i).openapi({ example: "sales" }), destinations: z.array(z.string().email()).min(1).max(20) })),
    responses: { 201: json(Alias, "The new alias."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => {
    const input = c.req.valid("json");
    const { auth, deps } = c.var;
    const a = await createAlias(deps.db, auth.orgId, { ...input, localPart: input.localPart.toLowerCase(), destinations: input.destinations.map((d) => d.toLowerCase()) });
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "alias.created", targetType: "alias", targetId: a.id, metadata: { address: a.address, via: "api" }, ip: c.var.ip });
    return c.json({ id: a.id, domainId: a.domainId, address: a.address, destinations: a.destinations, enabled: a.enabled, createdAt: iso(a.createdAt)! }, 201);
  });

  api.openapi(createRoute({ method: "delete", path: "/aliases/{id}", tags: ["Aliases"], summary: "Delete an alias", security: secured, request: { params: IdParam },
    responses: { 200: json(z.object({ deleted: z.literal(true) }), "Deleted."), 401: errors[401], 404: errors[404] } }),
  async (c) => {
    const { auth, deps } = c.var;
    await deleteAlias(deps.db, auth.orgId, c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  });

  api.openapi(createRoute({ method: "get", path: "/messages", tags: ["Messages"], summary: "List messages", description: "Newest first. Pass `cursor` from the previous page to get the next one.", security: secured,
    request: { query: z.object({
      mailboxId: z.string().optional(), folder: Folder.optional(), search: z.string().max(200).optional(),
      cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }) },
    responses: { 200: json(z.object({ data: z.array(MessageSummary), nextCursor: z.string().nullable() }), "A page of messages."), 401: errors[401], 422: errors[422] } }),
  async (c) => {
    const q = c.req.valid("query");
    const r = await listMessages(c.var.deps.db, c.var.auth.orgId, q);
    return c.json({ data: r.messages.map((m) => ({ ...m, date: iso(m.date)! })) as z.infer<typeof MessageSummary>[], nextCursor: r.nextCursor }, 200);
  });

  api.openapi(createRoute({ method: "get", path: "/messages/{id}", tags: ["Messages"], summary: "Get a message", security: secured, request: { params: IdParam },
    responses: { 200: json(Message, "The full message."), 401: errors[401], 404: errors[404] } }),
  async (c) => {
    const { deps, auth } = c.var;
    const m = await getMessage(deps.db, auth.orgId, c.req.valid("param").id);
    const full = (await getThread(deps.db, auth.orgId, m)).find((x) => x.id === m.id);
    return c.json({ ...full!, date: iso(full!.date)! } as z.infer<typeof Message>, 200);
  });

  api.openapi(createRoute({ method: "post", path: "/messages", tags: ["Messages"], summary: "Send a message", description: "Sends from one of your mailboxes. The domain must be verified. Counts toward the plan's daily sending limit.", security: secured,
    request: body(SendRequest),
    responses: { 200: json(SendResult, "Where each recipient's copy went."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => {
    const input = c.req.valid("json");
    const { auth, deps } = c.var;
    const mailboxId = input.mailboxId ?? (input.from ? (await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, auth.orgId), eq(mailboxes.address, input.from.toLowerCase()))).get())?.id : undefined);
    if (!mailboxId) throw new HttpError(422, "validation_failed", input.from ? `${input.from} isn't a mailbox in this workspace.` : "Pass mailboxId or from.");
    const result = await sendMessage(deps, auth, { ...input, mailboxId, to: input.to.map((a) => a.toLowerCase()), cc: input.cc?.map((a) => a.toLowerCase()), bcc: input.bcc?.map((a) => a.toLowerCase()) });
    return c.json(result, 200);
  });

  api.openapi(createRoute({ method: "get", path: "/webhooks", tags: ["Webhooks"], summary: "List webhook endpoints", security: secured,
    responses: { 200: json(z.object({ data: z.array(WebhookEndpoint) }), "Endpoints."), 401: errors[401] } }),
  async (c) => c.json({ data: (await listEndpoints(c.var.deps, c.var.auth.orgId)).map((e) => ({ ...e, createdAt: iso(e.createdAt)! })) }, 200));

  api.openapi(createRoute({ method: "post", path: "/webhooks", tags: ["Webhooks"], summary: "Add a webhook endpoint", description: `Events: ${WEBHOOK_EVENTS.join(", ")}, or "*" for all. The response carries the signing secret once.`, security: secured,
    request: body(z.object({ url: z.string().url().openapi({ example: "https://example.com/webhooks/mymail" }), events: z.array(z.enum([...WEBHOOK_EVENTS, "*"])).min(1), description: z.string().max(200).optional() })),
    // An illustrative value for the docs page, not a real secret.
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
    responses: { 201: json(WebhookEndpoint.extend({ secret: z.string().openapi({ example: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" }) }), "The endpoint and its signing secret."), 401: errors[401], 422: errors[422] } }),
  async (c) => {
    const { auth, deps } = c.var;
    const out = await createEndpoint(deps, auth.orgId, c.req.valid("json"));
    return c.json({ ...out.endpoint, createdAt: iso(out.endpoint.createdAt)!, secret: out.secret }, 201);
  });

  api.openapi(createRoute({ method: "delete", path: "/webhooks/{id}", tags: ["Webhooks"], summary: "Delete a webhook endpoint", security: secured, request: { params: IdParam },
    responses: { 200: json(z.object({ deleted: z.literal(true) }), "Deleted."), 401: errors[401], 404: errors[404] } }),
  async (c) => {
    await deleteEndpoint(c.var.deps, c.var.auth.orgId, c.req.valid("param").id);
    return c.json({ deleted: true as const }, 200);
  });

  registerAgentRoutes(api);
  registerAuthHookRoutes(api);
  registerSuiteRoutes(api);
  registerSuiteR7Routes(api);
  registerSuiteR8Routes(api);
  registerSuiteR10Routes(api);
  registerSuiteR11Routes(api);
  registerPeopleRoutes(api);
  registerMcpRoute(api);
  return api;
}
