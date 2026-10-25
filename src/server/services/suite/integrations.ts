/**
 * Integrations (round 11). Outgoing: a catalogue of no-cost targets (Slack, Discord, Teams,
 * Zapier, Make, n8n, Google Sheets, any URL) built on the signed outgoing webhooks; chat apps
 * get a message body, the rest our standard signed JSON event. Incoming: a secret URL per hook
 * (/api/hooks/in/<token>) that turns a JSON or form post into a task, a chat message or a
 * contact. A call costs the action's own writes plus one update of the hook row.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { incomingHooks, members, users, webhookEndpoints } from "../../db/schema";
import { randomToken, sha256Hex as sha256 } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { WEBHOOK_EVENTS, createEndpoint, emitEvent, presentEndpoint, type EndpointFormat } from "../developer/webhooks";
import { assertWritable, sortableId, type SuiteActor } from "./common";

export interface Connector {
  id: string; name: string; description: string; icon: string; format: EndpointFormat;
  events: string[]; urlHint: string; help: string;
}

const WORK = ["task.created", "task.updated", "chat.mention", "form.submitted", "deal.created", "booking.created"];
const ALL = ["task.created", "task.updated", "task.commented", "contact.created", "deal.created", "deal.updated", "form.submitted", "meeting.created", "booking.created", "booking.cancelled", "message.received"];

/** The no-cost targets. Icons are Lucide names; no third party logos. */
export const CATALOGUE: Connector[] = [
  { id: "slack", name: "Slack", description: "Post updates to a Slack channel through an incoming webhook.", icon: "Hash", format: "slack", events: WORK, urlHint: "https://hooks.slack.com/services/...", help: "In Slack, add the Incoming Webhooks app to a channel and copy its webhook URL." },
  { id: "discord", name: "Discord", description: "Post updates to a Discord channel through a channel webhook.", icon: "MessagesSquare", format: "discord", events: WORK, urlHint: "https://discord.com/api/webhooks/...", help: "In Discord, open channel settings, Integrations, Webhooks, then New Webhook and copy its URL." },
  { id: "teams", name: "Microsoft Teams", description: "Post updates to a Teams channel through a Workflows webhook (sent as an Adaptive Card) or an older incoming webhook.", icon: "Users", format: "teams", events: WORK, urlHint: "https://...logic.azure.com/workflows/...", help: "In Teams, open Workflows, pick \"Post to a channel when a webhook request is received\", choose the channel and copy the URL. An older Incoming Webhook URL works too." },
  { id: "zapier", name: "Zapier", description: "Start a Zap with a Catch Hook trigger and reach thousands of apps.", icon: "Zap", format: "json", events: ALL, urlHint: "https://hooks.zapier.com/hooks/catch/...", help: "In Zapier, create a Zap with Webhooks by Zapier, Catch Hook, and paste its URL here." },
  { id: "make", name: "Make", description: "Start a Make scenario with a custom webhook.", icon: "Workflow", format: "json", events: ALL, urlHint: "https://hook.eu1.make.com/...", help: "In Make, add a Webhooks module, Custom webhook, and copy its address." },
  { id: "n8n", name: "n8n", description: "Start an n8n workflow, cloud or self hosted, with a Webhook node.", icon: "GitBranch", format: "json", events: ALL, urlHint: "https://your-n8n.example.com/webhook/...", help: "In n8n, add a Webhook node set to POST and copy its production URL." },
  { id: "sheets", name: "Google Sheets", description: "Add a row per event through a Google Apps Script web app.", icon: "Sheet", format: "json", events: ["task.created", "form.submitted", "contact.created", "booking.created"], urlHint: "https://script.google.com/macros/s/.../exec", help: "In your sheet, open Extensions, Apps Script, add a doPost(e) that appends JSON.parse(e.postData.contents) as a row, deploy it as a web app for anyone, and copy the URL." },
  { id: "custom", name: "Any URL (JSON)", description: "Send our standard signed JSON event to any HTTPS endpoint.", icon: "Webhook", format: "json", events: ALL, urlHint: "https://example.com/webhooks/multies", help: "Your endpoint gets a POST with the event as JSON and Standard Webhooks signature headers." },
];

export function connector(id: string) {
  const c = CATALOGUE.find((x) => x.id === id);
  if (!c) throw new HttpError(422, "validation_failed", "Unknown integration.");
  return c;
}

const LABEL: Record<string, string> = {
  "task.created": "New task", "task.updated": "Task updated", "task.commented": "New comment", "task.deleted": "Task deleted",
  "chat.mention": "Mentioned in chat", "chat.message.created": "New chat message", "form.submitted": "Form submitted",
  "deal.created": "New deal", "deal.updated": "Deal updated", "contact.created": "New contact", "meeting.created": "Meeting scheduled",
  "booking.created": "New booking", "booking.cancelled": "Booking cancelled", "message.received": "New email",
  "incoming_hook.received": "Incoming webhook", "webhook.test": "Test",
};

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** One line of plain text for a chat app: what happened and the item's name. */
export function eventText(e: { type: string; data?: Record<string, unknown> }, appName = "Multies") {
  const d = e.data ?? {};
  const label = LABEL[e.type] ?? e.type;
  if (e.type === "webhook.test") return `${appName}: test message. This channel is connected.`;
  const item = (d.task && typeof d.task === "object" ? d.task : d) as Record<string, unknown>;
  const name = str(item.title) || str(item.name) || str(item.subject) || str(d.formName) || str(d.email);
  const ref = str(item.ref);
  const who = d.actor && typeof d.actor === "object" ? str((d.actor as Record<string, unknown>).name) : "";
  const when = e.type.startsWith("booking.") && str(d.startsAt) ? ` at ${str(d.startsAt).replace("T", " ").slice(0, 16)} UTC` : "";
  return `${appName}: ${label}${name ? `: ${ref ? `${ref} ` : ""}${name}` : ""}${when}${who ? ` (by ${who})` : ""}`.slice(0, 1500);
}

/**
 * True for a Teams Workflows (Power Automate) webhook URL. Those flows read an Adaptive Card
 * message; the older Office 365 connector URLs (webhook.office.com) take plain text.
 */
export function isTeamsWorkflowsUrl(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host.endsWith(".logic.azure.com") || host.endsWith(".powerplatform.com") || host.endsWith(".powerautomate.com") || /\/workflows\//i.test(u.pathname);
  } catch {
    return false;
  }
}

/** The message a Teams Workflows "post to a channel when a webhook request is received" flow expects. */
export function teamsWorkflowsCard(e: { type: string; data?: Record<string, unknown> }, appName = "Multies", appUrl?: string) {
  const text = eventText(e, appName);
  const prefix = `${appName}: `;
  const body = [
    { type: "TextBlock", text: LABEL[e.type] ?? e.type, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: text.startsWith(prefix) ? text.slice(prefix.length) : text, wrap: true },
    { type: "TextBlock", text: appName, isSubtle: true, spacing: "Small", size: "Small", wrap: true },
  ];
  const card: Record<string, unknown> = { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body };
  if (appUrl && /^https:\/\//.test(appUrl)) card.actions = [{ type: "Action.OpenUrl", title: `Open ${appName}`, url: appUrl }];
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] };
}

export async function listIntegrations(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId)).orderBy(asc(webhookEndpoints.createdAt));
  return { catalogue: CATALOGUE, connections: rows.filter((r) => r.connector).map(presentEndpoint) };
}

export async function connectIntegration(deps: Deps, actor: SuiteActor, input: { connector: string; url: string; events?: string[]; name?: string }) {
  assertWritable(actor);
  const c = connector(input.connector);
  const events = (input.events?.length ? input.events : c.events).filter((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e) || e === "*");
  if (!events.length) throw new HttpError(422, "validation_failed", "Choose at least one event.");
  const r = await createEndpoint(deps, actor.orgId, { url: input.url, events, description: input.name?.trim() || c.name, format: c.format, connector: c.id });
  // Chat apps do not verify signatures, so the secret is only worth showing for JSON targets.
  return { connection: r.endpoint, secret: c.format === "json" ? r.secret : undefined };
}

// ---------------------------------------------------------------- incoming

export type HookAction = "task" | "chat" | "contact";
export interface HookConfig { projectId?: string; channelId?: string; mapping?: Record<string, string> }
export interface HookCall { at: string; ok: boolean; status: number; result?: { type: string; id: string }; error?: string }

export const MAX_HOOKS = 20;
export const MAX_PAYLOAD = 64 * 1024;
const RECENT = 20;

/** Default source fields per target, tried in order. Paths may be dotted (data.title). */
export const DEFAULT_FIELDS: Record<HookAction, Record<string, string[]>> = {
  task: { title: ["title", "text", "subject", "name", "summary"], notes: ["notes", "description", "body", "message", "details"], due: ["due", "due_date", "dueDate", "deadline"], assignee: ["assignee", "assignee_email", "assigneeEmail", "owner"] },
  chat: { text: ["text", "message", "body", "content", "title", "subject"] },
  contact: { email: ["email", "email_address", "emailAddress"], name: ["name", "full_name", "fullName"], phone: ["phone", "phone_number", "phoneNumber", "mobile"], notes: ["notes", "message", "comments"] },
};

function pick(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Reads each target field from the payload: the hook's own mapping first, then the defaults. */
export function mapFields(action: HookAction, payload: Record<string, unknown>, mapping: Record<string, string> = {}) {
  const out: Record<string, string> = {};
  for (const [target, defaults] of Object.entries(DEFAULT_FIELDS[action])) {
    for (const path of mapping[target] ? [mapping[target]] : defaults) {
      const v = str(pick(payload, path)).trim();
      if (v) { out[target] = v; break; }
    }
  }
  if (action === "contact" && !out.name) {
    const n = [str(payload.first_name ?? payload.firstName), str(payload.last_name ?? payload.lastName)].join(" ").trim();
    if (n) out.name = n;
  }
  return out;
}

type HookRow = typeof incomingHooks.$inferSelect;

function presentHook(h: HookRow, appUrl: string) {
  return {
    id: h.id, name: h.name, action: h.action, config: JSON.parse(h.config) as HookConfig, enabled: h.enabled,
    url: `${appUrl}/api/hooks/in/${h.tokenHint}...`, tokenHint: h.tokenHint, callCount: h.callCount,
    lastCalledAt: h.lastCalledAt ? h.lastCalledAt.toISOString() : null, recent: JSON.parse(h.recent) as HookCall[], createdAt: h.createdAt.toISOString(),
  };
}
export type IncomingHook = ReturnType<typeof presentHook>;

async function hookRow(deps: Deps, orgId: string, id: string) {
  const h = await deps.db.select().from(incomingHooks).where(and(eq(incomingHooks.orgId, orgId), eq(incomingHooks.id, id))).get();
  if (!h) throw notFound("Incoming webhook");
  return h;
}

function checkConfig(action: HookAction, config: HookConfig) {
  if (action === "chat" && !config.channelId) throw new HttpError(422, "validation_failed", "Choose the channel to post in.");
  for (const [k, v] of Object.entries(config.mapping ?? {})) {
    if (!(k in DEFAULT_FIELDS[action])) throw new HttpError(422, "validation_failed", `Unknown field for this action: ${k}`);
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(v)) throw new HttpError(422, "validation_failed", `Use a field name like title or data.title for ${k}.`);
  }
}

export async function listIncomingHooks(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(incomingHooks).where(eq(incomingHooks.orgId, orgId)).orderBy(asc(incomingHooks.createdAt));
  return rows.map((h) => presentHook(h, deps.config.appUrl));
}

export async function getIncomingHook(deps: Deps, orgId: string, id: string) {
  return presentHook(await hookRow(deps, orgId, id), deps.config.appUrl);
}

/** Creates a hook. The token is returned once; only its hash is kept. */
export async function createIncomingHook(deps: Deps, actor: SuiteActor, input: { name: string; action: HookAction; config?: HookConfig }) {
  assertWritable(actor);
  const config = input.config ?? {};
  checkConfig(input.action, config);
  if (input.action === "chat") {
    const { getChannel } = await import("./chat");
    await getChannel(deps, actor, config.channelId!);
  }
  const count = (await deps.db.select({ id: incomingHooks.id }).from(incomingHooks).where(eq(incomingHooks.orgId, actor.orgId))).length;
  if (count >= MAX_HOOKS) throw new HttpError(409, "conflict", `A workspace can have up to ${MAX_HOOKS} incoming webhooks.`);
  const token = `mih_${randomToken(24).replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
  const id = sortableId("ihk", deps.now().getTime());
  await deps.db.insert(incomingHooks).values({
    id, orgId: actor.orgId, name: input.name.trim().slice(0, 80), action: input.action, config: JSON.stringify(config),
    tokenHash: await sha256(token), tokenHint: token.slice(0, 8), createdById: actor.agentId ? null : actor.userId || null, createdAt: deps.now(),
  });
  return { hook: presentHook(await hookRow(deps, actor.orgId, id), deps.config.appUrl), token, url: `${deps.config.appUrl}/api/hooks/in/${token}` };
}

export async function updateIncomingHook(deps: Deps, actor: SuiteActor, id: string, patch: { name?: string; enabled?: boolean; config?: HookConfig }) {
  assertWritable(actor);
  const h = await hookRow(deps, actor.orgId, id);
  if (patch.config) checkConfig(h.action, patch.config);
  await deps.db.update(incomingHooks).set({
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.config ? { config: JSON.stringify(patch.config) } : {}),
  }).where(eq(incomingHooks.id, h.id));
  return presentHook(await hookRow(deps, actor.orgId, id), deps.config.appUrl);
}

export async function deleteIncomingHook(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const h = await hookRow(deps, actor.orgId, id);
  await deps.db.delete(incomingHooks).where(eq(incomingHooks.id, h.id));
  return { deleted: true, id };
}

async function memberByEmail(deps: Deps, orgId: string, email: string) {
  const r = await deps.db.select({ id: users.id }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(users.email, email.toLowerCase()))).get();
  return r?.id ?? null;
}

async function runAction(deps: Deps, h: HookRow, payload: Record<string, unknown>): Promise<{ type: string; id: string }> {
  const config = JSON.parse(h.config) as HookConfig;
  const f = mapFields(h.action, payload, config.mapping);
  const actor: SuiteActor = { orgId: h.orgId, userId: h.createdById ?? "", email: "", name: h.name, system: true };
  if (h.action === "task") {
    if (!f.title) throw new HttpError(422, "validation_failed", "No title found. Send title, text or subject, or map a field to the title.");
    let notes = f.notes;
    if (!notes) {
      const used = new Set(Object.values(DEFAULT_FIELDS.task).flat());
      const rest = Object.entries(payload).filter(([k, v]) => !used.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")).slice(0, 30);
      if (rest.length) notes = rest.map(([k, v]) => `${k}: ${String(v)}`).join("\n").slice(0, 5000);
    }
    const assigneeId = f.assignee && f.assignee.includes("@") ? await memberByEmail(deps, h.orgId, f.assignee) : null;
    const { createTask } = await import("./tasks");
    const t = await createTask(deps, actor, {
      title: f.title.slice(0, 300), notes: notes?.slice(0, 20_000), projectId: config.projectId, due: f.due ?? null,
      assignee: assigneeId ? { type: "member", id: assigneeId } : null,
      triage: { source: "api", when: "if_project" },
    });
    return { type: "task", id: t.id };
  }
  if (h.action === "chat") {
    if (!f.text) throw new HttpError(422, "validation_failed", "No message found. Send text or message, or map a field to the text.");
    const { postMessage } = await import("./chat");
    const m = await postMessage(deps, { ...actor, apiKeyId: `hook:${h.id}` }, config.channelId!, { body: f.text.slice(0, 20_000) });
    return { type: "chat_message", id: m.id };
  }
  if (!f.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw new HttpError(422, "validation_failed", "No valid email found. Send email, or map a field to the email.");
  const { createContact } = await import("./contacts");
  const c = await createContact(deps, actor, { email: f.email, name: f.name, phone: f.phone, notes: f.notes });
  return { type: "contact", id: (c as { id: string }).id };
}

/**
 * The public endpoint's work. Unknown or revoked tokens answer 404 with no write. A known hook
 * records the call (status, result or error) in its own row: one update per call.
 */
export async function receiveIncoming(deps: Deps, token: string, payload: Record<string, unknown>) {
  if (!/^mih_[A-Za-z0-9]{16,64}$/.test(token)) throw notFound("Incoming webhook");
  const h = await deps.db.select().from(incomingHooks).where(eq(incomingHooks.tokenHash, await sha256(token))).get();
  if (!h || !h.enabled) throw notFound("Incoming webhook");
  const at = deps.now();
  let call: HookCall;
  let failure: HttpError | null = null;
  try {
    const result = await runAction(deps, h, payload);
    call = { at: at.toISOString(), ok: true, status: 201, result };
  } catch (err) {
    failure = err instanceof HttpError ? err : new HttpError(500, "hook_failed", "The action could not be completed.");
    if (!(err instanceof HttpError)) deps.reportError?.(err, { where: "incoming_hook", hook: h.id });
    call = { at: at.toISOString(), ok: false, status: failure.status, error: failure.message.slice(0, 200) };
  }
  const recent = [call, ...(JSON.parse(h.recent) as HookCall[])].slice(0, RECENT);
  await deps.db.update(incomingHooks).set({ callCount: h.callCount + 1, lastCalledAt: at, recent: JSON.stringify(recent) }).where(eq(incomingHooks.id, h.id));
  if (failure) throw failure;
  await emitEvent(deps, h.orgId, "incoming_hook.received", { hook: { id: h.id, name: h.name, action: h.action }, result: call.result });
  return { ok: true, result: call.result };
}

/** Reads a JSON, form or plain text body into an object, capped at 64 KB. */
export async function readHookPayload(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_PAYLOAD) throw new HttpError(413, "payload_too_large", "Send at most 64 KB.");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_PAYLOAD) throw new HttpError(413, "payload_too_large", "Send at most 64 KB.");
  const raw = new TextDecoder().decode(buf);
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  if (type.includes("multipart/form-data")) {
    const form = await new Response(buf, { headers: { "content-type": type } }).formData();
    const out: Record<string, unknown> = {};
    form.forEach((v, k) => { if (typeof v === "string") out[k] = v; });
    return out;
  }
  if (!raw.trim()) throw new HttpError(422, "validation_failed", "The body is empty.");
  try {
    const v = JSON.parse(raw) as unknown;
    const obj = Array.isArray(v) ? v[0] : v;
    if (obj && typeof obj === "object") return obj as Record<string, unknown>;
  } catch {
    if (!type.includes("json")) return { text: raw.slice(0, 20_000) };
  }
  throw new HttpError(422, "validation_failed", "Send a JSON object or a form post.");
}
