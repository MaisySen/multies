/**
 * Round 10 in the public API (v1): team chat, templates and goals with key results.
 * API keys read and post in public channels only; DMs and private channels stay between people.
 * An agent key posts as its agent, and @mentions of an agent arrive as the chat.mention webhook.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { idempotentCreate, templateUseIds } from "../lib/idempotency"; // R52 (MB-239), R54
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { channelMessages, createChannel, getThread, listChannels, listPins, messageToTask, pinMessage, postMessageAcked, updateChannel } from "../services/suite/chat";
import { ackFor } from "../services/suite/chat-ack-r33";
import { getTemplate, listTemplates, saveTemplate, useTemplate } from "../services/suite/templates";
import { addKeyResult, createGoal, getGoal, goalTree, updateGoal, updateKeyResult } from "../services/suite/goals";
import { parseAssignee } from "../services/suite/tasks";
import { ChannelCreate, ChannelPatch, ChatPost, GoalCreate, GoalPatch, KrCreate, KrPatch, MessageToTask, MessagesQuery, TemplateSave, TemplateUse, decodeAttachments } from "./suite-r10";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } as const;
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
// The request schemas are shared with the app routes; z.any() keeps the zod copies apart in types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (schema: any) => ({ body: { required: true, content: { "application/json": { schema } } } });
const secured = [{ bearerAuth: [] }];
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonBody = async (c: Context<AppEnv>, schema: { parse: (v: unknown) => any }) => schema.parse(await c.req.json().catch(() => ({})));

const pid = (c: Context<AppEnv>) => c.req.param("id") ?? "";

export function registerSuiteR10Routes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post" | "patch" | "delete", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: secured, ...extra, responses: { 200: json("OK."), 201: json("Created."), 401: errors[401], 403: errors[403], 404: errors[404], 422: errors[422] } });

  // ---------------------------------------------------------------- chat
  api.openapi(route("get", "/chat/channels", "Chat", "List public channels", "Public channels in the workspace with their topic and last message. DMs and private channels are only for people."),
    async (c) => send(c, { channels: await listChannels(c.var.deps, actor(c)) }));
  api.openapi(route("post", "/chat/channels", "Chat", "Create a public channel", "Body: { name, topic?, projectId?, guestAccess? }. With projectId and guestAccess the project's guests can read and post.", { request: body(ChannelCreate) }),
    async (c) => send(c, { channel: await createChannel(c.var.deps, actor(c), await jsonBody(c, ChannelCreate), await idempotentCreate(c.req.raw, "chn")) }, 201));
  api.openapi(route("patch", "/chat/channels/{id}", "Chat", "Update a channel", "Body: { name?, topic?, archived?, projectId?, guestAccess? }. The topic is the channel's purpose line.", { request: { params: Id, ...body(ChannelPatch) } }),
    async (c) => send(c, { channel: await updateChannel(c.var.deps, actor(c), pid(c), await jsonBody(c, ChannelPatch)) }));
  api.openapi(route("get", "/chat/channels/{id}/pins", "Chat", "List pinned messages", "The channel's pinned messages, newest pin first (up to 50).", { request: { params: Id } }),
    async (c) => send(c, await listPins(c.var.deps, actor(c), pid(c))));
  api.openapi(route("post", "/chat/messages/{id}/pin", "Chat", "Pin a message", "Pins a top level message to the top of its channel. Pinning a pinned message changes nothing.", { request: { params: Id } }),
    async (c) => send(c, { message: await pinMessage(c.var.deps, actor(c), pid(c), true) }));
  api.openapi(route("delete", "/chat/messages/{id}/pin", "Chat", "Unpin a message", "Takes the message off the channel's pinned list.", { request: { params: Id } }),
    async (c) => send(c, { message: await pinMessage(c.var.deps, actor(c), pid(c), false) }));
  api.openapi(route("get", "/chat/channels/{id}/messages", "Chat", "Read a channel", "Top level messages, oldest first. Query: limit, before (a message id) or since (ISO time, for polling). Each message carries mentions, links to tasks, threads and docs, attachments and its reply count.", { request: { params: Id } }),
    async (c) => send(c, await channelMessages(c.var.deps, actor(c), pid(c), MessagesQuery.parse(c.req.query()))));
  api.openapi(route("post", "/chat/channels/{id}/messages", "Chat", "Post a message", "Body: { body, parentId?, attachments?: [{ filename, contentType?, contentBase64 }], clientMsgId? }. clientMsgId (9 base 36 characters of send time in ms, then 8 to 40 more) makes the send safe to repeat: a repeat answers 200 with the first message, and the answer carries ack { type, reply_to, ok, message: { id, ts }, deduped }. Markup: <@member:USER_ID> mentions a person, <@agent:AGENT_ID> an agent, <!channel> everyone; <#task:ID>, <#thread:ID> and <#doc:ID> link items. An agent key posts as its agent.", { request: { params: Id, ...body(ChatPost) } }),
    async (c) => {
      const b = await jsonBody(c, ChatPost);
      const r = await postMessageAcked(c.var.deps, actor(c), pid(c), { body: b.body, parentId: b.parentId, files: decodeAttachments(b.attachments), clientMsgId: b.clientMsgId }, await idempotentCreate(c.req.raw, "chm"));
      return send(c, { message: r.message, ...(b.clientMsgId ? { ack: ackFor(b.clientMsgId, r.message, r.deduped) } : {}) }, r.deduped ? 200 : 201);
    });
  api.openapi(route("get", "/chat/messages/{id}/thread", "Chat", "Read a thread", "The top level message and its replies.", { request: { params: Id } }),
    async (c) => send(c, await getThread(c.var.deps, actor(c), pid(c))));
  api.openapi(route("post", "/chat/messages/{id}/task", "Chat", "Turn a message into a task", "Body: { title?, projectId?, assignee?: member:<id> or agent:<id>, due?, triage? }. The task links back to the message, and the message shows the task. With triage: true it waits in the Triage queue (source chat) until someone accepts it.", { request: { params: Id, ...body(MessageToTask) } }),
    async (c) => {
      const b = await jsonBody(c, MessageToTask);
      return send(c, { task: await messageToTask(c.var.deps, actor(c), pid(c), { title: b.title, projectId: b.projectId, assignee: parseAssignee(b.assignee), due: b.due, triage: b.triage }, await idempotentCreate(c.req.raw, "tsk")) }, 201);
    });

  // ---------------------------------------------------------------- templates
  api.openapi(route("get", "/templates", "Templates", "List templates", "The starter gallery (client onboarding, content calendar, sales pipeline, bug tracker, meeting notes, project brief) and the workspace's saved project, task and doc templates."),
    async (c) => send(c, { templates: await listTemplates(c.var.deps, actor(c).orgId) }));
  api.openapi(route("get", "/templates/{id}", "Templates", "Read a template", "The template with its statuses, fields and tasks.", { request: { params: Id } }),
    async (c) => send(c, { template: await getTemplate(c.var.deps, actor(c).orgId, pid(c)) }));
  api.openapi(route("post", "/templates", "Templates", "Create a template", "Body: { kind: project | task | doc, name?, description?, category?, and either data (write it from scratch) or fromProjectId, fromTaskId or fromDocId (save an existing item) }. data for a project: { project: { name, description?, color? }, tasks: [{ title, notes?, priority?, dueInDays?, subtasks? }] }; for a task: { title, notes?, subtasks?, ... }; for a doc: { title, text } (one paragraph per line, # headings, - bullets).", { request: body(TemplateSave) }),
    async (c) => send(c, { template: await saveTemplate(c.var.deps, actor(c), await jsonBody(c, TemplateSave), await idempotentCreate(c.req.raw, "tpl")) }, 201));
  api.openapi(route("post", "/templates/{id}/use", "Templates", "Make a project, task or doc from a template", "Body: { name?, projectId? (needed for a task template, optional for a doc), startDate? (YYYY-MM-DD, due dates count from it) }.", { request: { params: Id, ...body(TemplateUse) } }),
    async (c) => send(c, await useTemplate(c.var.deps, actor(c), pid(c), await jsonBody(c, TemplateUse), await templateUseIds(c.req.raw)), 201));

  // ---------------------------------------------------------------- goals
  api.openapi(route("get", "/goals", "Goals", "List goals with progress", "Every goal as a tree with its key results, progress (0 to 100, rolled up from key results and child goals) and health, plus a portfolio summary."),
    async (c) => send(c, await goalTree(c.var.deps, actor(c).orgId)));
  api.openapi(route("post", "/goals", "Goals", "Create a goal", "Body: { name, description?, ownerId?, parentId?, start?, due?, health?, keyResults?: [...] }.", { request: body(GoalCreate) }),
    async (c) => send(c, { goal: await createGoal(c.var.deps, actor(c), await jsonBody(c, GoalCreate), await idempotentCreate(c.req.raw, "gol")) }, 201));
  api.openapi(route("get", "/goals/{id}", "Goals", "Read a goal", "The goal with key results and child goals.", { request: { params: Id } }),
    async (c) => send(c, { goal: await getGoal(c.var.deps, actor(c).orgId, pid(c)) }));
  api.openapi(route("patch", "/goals/{id}", "Goals", "Update a goal", "Any of name, description, ownerId, parentId, start, due, health (on_track, at_risk, off_track or null), archived.", { request: { params: Id, ...body(GoalPatch) } }),
    async (c) => send(c, { goal: await updateGoal(c.var.deps, actor(c), pid(c), await jsonBody(c, GoalPatch)) }));
  api.openapi(route("post", "/goals/{id}/key-results", "Goals", "Add a key result", "Body: { name, kind: number | currency (AUD) | percent | tasks, start?, target?, current?, unit?, projectId?, taskIds? }. A tasks key result measures linked tasks, or every top level task in a project.", { request: { params: Id, ...body(KrCreate) } }),
    async (c) => send(c, { keyResult: await addKeyResult(c.var.deps, actor(c), pid(c), await jsonBody(c, KrCreate), await idempotentCreate(c.req.raw, "kr")) }, 201));
  api.openapi(route("patch", "/key-results/{id}", "Goals", "Update a key result", "Set current to record progress, or change the target, the linked tasks or the project.", { request: { params: Id, ...body(KrPatch) } }),
    async (c) => send(c, { keyResult: await updateKeyResult(c.var.deps, actor(c), pid(c), await jsonBody(c, KrPatch)) }));
}
