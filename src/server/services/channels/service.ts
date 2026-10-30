/**
 * C1: chat channels for the web app (routes/channels.ts). Every inbox call needs the workspace switch on
 * (organizations.channels_enabled, off by default; admins turn it on in Settings, Channels) and a member of the
 * workspace. Connecting and disconnecting a channel is for owners and admins. Tokens never leave the server.
 */
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Deps, AuthContext } from "../../context";
import { members, msgChannels, msgConversations, msgMessages, organizations, tasks, threadComments, usageCounters, users } from "../../db/schema";
import { encryptSecret, fromB64, newId } from "../../lib/crypto";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { createTask } from "../suite/tasks";
import { sortableId } from "../suite/common";
import {
  PROVIDER_LABEL, fillTemplateBody, replyWindow, type ChannelSummary, type ChannelsStatus, type ChatMessage, type ChatTemplate, type ConversationDetail, type ConversationSummary,
} from "@/shared/channels";
import { INBOUND_METRIC, MEDIA_INLINE_MAX, snippetOf, utcDay } from "./ingest";
import { mediaTypeFor } from "./meta";
import { ProviderError } from "./provider";
import { adapterFor, credentialsOf, type ChannelRow } from "./registry";

type ConvRow = typeof msgConversations.$inferSelect;
type MsgRow = typeof msgMessages.$inferSelect;

export const NOTE_MAX = 4000;
export const TEXT_MAX = 4096; // WhatsApp's text body limit
export const FILE_MAX = 5 * 1024 * 1024;
const isAdmin = (a: AuthContext) => a.role === "owner" || a.role === "admin";

// ---- settings ----------------------------------------------------------------------------------------

async function orgEnabled(deps: Deps, orgId: string) {
  const o = await deps.db.select({ on: organizations.channelsEnabled }).from(organizations).where(eq(organizations.id, orgId)).get();
  return !!o?.on;
}

/** 404 for the whole inbox side when the workspace has channels off: the inbox shows mail only. */
async function requireEnabled(deps: Deps, a: AuthContext) {
  if (!(await orgEnabled(deps, a.orgId))) throw notFound("Conversation");
}

export const summarizeChannel = (c: ChannelRow): ChannelSummary => ({
  id: c.id, provider: c.provider, name: c.name, handle: c.handle, status: c.status,
  connectedAt: c.connectedAt.toISOString(), disconnectedAt: c.disconnectedAt ? c.disconnectedAt.toISOString() : null,
  lastError: c.status === "error" ? (c.lastError ?? "Connect this channel again.") : null,
});

export async function channelsStatus(deps: Deps, a: AuthContext): Promise<ChannelsStatus> {
  const { meta, mock, dailySoftCap } = deps.config.channels;
  const [enabled, rows, counter] = await Promise.all([
    orgEnabled(deps, a.orgId),
    deps.db.select().from(msgChannels).where(eq(msgChannels.orgId, a.orgId)).orderBy(asc(msgChannels.createdAt)),
    deps.db.select({ count: usageCounters.count }).from(usageCounters)
      .where(and(eq(usageCounters.orgId, a.orgId), eq(usageCounters.period, utcDay(deps.now())), eq(usageCounters.metric, INBOUND_METRIC))).get(),
  ]);
  const today = counter?.count ?? 0;
  return {
    available: !!meta || mock, mock, enabled, canManage: isAdmin(a),
    channels: rows.map(summarizeChannel),
    embeddedSignup: meta ? { appId: meta.appId, configId: meta.configId, graphVersion: meta.graphVersion } : null,
    usage: { today, softCap: dailySoftCap, level: today >= dailySoftCap ? "over" : today >= dailySoftCap * 0.8 ? "near" : "ok" },
  };
}

export async function setEnabled(deps: Deps, a: AuthContext, enabled: boolean) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can change channels.");
  if (enabled && !deps.config.channels.meta && !deps.config.channels.mock) throw new HttpError(409, "channel_unavailable", "Messaging channels are not set up on this server yet.");
  await deps.db.update(organizations).set({ channelsEnabled: enabled }).where(eq(organizations.id, a.orgId));
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: enabled ? "channels.enabled" : "channels.disabled" }).catch(() => undefined);
  return channelsStatus(deps, a);
}

async function saveChannel(deps: Deps, a: AuthContext, c: { provider: ChannelRow["provider"]; externalId: string; accountId: string | null; name: string; handle: string | null; secret: Record<string, string> }) {
  const taken = await deps.db.select().from(msgChannels).where(and(eq(msgChannels.provider, c.provider), eq(msgChannels.externalId, c.externalId), eq(msgChannels.status, "active"))).get();
  if (taken && taken.orgId !== a.orgId) throw new HttpError(409, "channel_taken", "This number is already connected to another workspace. Disconnect it there first.");
  const tokenEnc = await encryptSecret(deps.config.appSecret, JSON.stringify(c.secret));
  const now = deps.now();
  // Reconnecting the same number in this workspace brings its history back.
  const prior = taken ?? await deps.db.select().from(msgChannels).where(and(eq(msgChannels.orgId, a.orgId), eq(msgChannels.provider, c.provider), eq(msgChannels.externalId, c.externalId))).get();
  if (prior) {
    await deps.db.update(msgChannels).set({ tokenEnc, status: "active", name: c.name, handle: c.handle, externalAccountId: c.accountId, lastError: null, connectedBy: a.userId, connectedAt: now, disconnectedAt: null }).where(eq(msgChannels.id, prior.id));
  } else {
    await deps.db.insert(msgChannels).values({ id: newId("chn"), orgId: a.orgId, provider: c.provider, externalId: c.externalId, externalAccountId: c.accountId, name: c.name, handle: c.handle, tokenEnc, status: "active", connectedBy: a.userId, connectedAt: now, createdAt: now });
  }
  const row = await deps.db.select().from(msgChannels).where(and(eq(msgChannels.orgId, a.orgId), eq(msgChannels.provider, c.provider), eq(msgChannels.externalId, c.externalId))).get();
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "channels.connected", targetType: "channel", targetId: row!.id, metadata: { provider: c.provider } }).catch(() => undefined);
  return summarizeChannel(row!);
}

export async function connectWhatsApp(deps: Deps, a: AuthContext, b: { code: string; wabaId: string; phoneNumberId: string; coexistence?: boolean }) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can connect channels.");
  if (!deps.config.channels.meta) throw new HttpError(409, "channel_unavailable", "Messaging channels are not set up on this server yet.");
  let r;
  try {
    r = await adapterFor(deps, "whatsapp").connect({ code: b.code, accountId: b.wabaId, externalId: b.phoneNumberId, coexistence: b.coexistence });
  } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(502, "provider_refused", e.message);
    throw e;
  }
  return saveChannel(deps, a, { provider: "whatsapp", externalId: b.phoneNumberId, accountId: b.wabaId, name: r.name, handle: r.handle, secret: r.pin ? { token: r.token, pin: r.pin } : { token: r.token } });
}

export async function connectMock(deps: Deps, a: AuthContext, name?: string) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can connect channels.");
  if (!deps.config.channels.mock) throw notFound("Test channel");
  const r = await adapterFor(deps, "mock").connect({ code: "", accountId: "", externalId: "" });
  const externalId = `mock_${a.orgId}`;
  return saveChannel(deps, a, { provider: "mock", externalId, accountId: "mock_waba", name: name?.trim().slice(0, 80) || r.name, handle: r.handle, secret: { token: r.token } });
}

export async function disconnectChannel(deps: Deps, a: AuthContext, id: string) {
  if (!isAdmin(a)) throw forbidden("Only owners and admins can disconnect channels.");
  const ch = await deps.db.select().from(msgChannels).where(and(eq(msgChannels.id, id), eq(msgChannels.orgId, a.orgId))).get();
  if (!ch) throw notFound("Channel");
  // The token is wiped; conversations and messages stay readable.
  await deps.db.update(msgChannels).set({ status: "disconnected", tokenEnc: null, disconnectedAt: deps.now() }).where(eq(msgChannels.id, id));
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "channels.disconnected", targetType: "channel", targetId: id }).catch(() => undefined);
  return summarizeChannel({ ...ch, status: "disconnected", tokenEnc: null, disconnectedAt: deps.now() });
}

// ---- inbox ---------------------------------------------------------------------------------------------

const parseLabels = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } };

async function namesOf(deps: Deps, ids: (string | null)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 90);
  if (!list.length) return new Map<string, string>();
  const rows = await deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name || r.email]));
}

function summarize(c: ConvRow, provider: ChannelRow["provider"], names: Map<string, string>): ConversationSummary {
  return {
    id: c.id, channelId: c.channelId, provider, contactName: c.contactName || c.contactExternalId, contactHandle: c.contactExternalId,
    snippet: c.snippet, lastMessageAt: c.lastMessageAt.toISOString(), lastInboundAt: c.lastInboundAt ? c.lastInboundAt.toISOString() : null,
    unreadCount: c.unreadCount, status: c.status,
    assignee: c.assigneeUserId ? { userId: c.assigneeUserId, name: names.get(c.assigneeUserId) ?? "Teammate" } : null,
    labels: parseLabels(c.labels),
  };
}

export interface ListQuery { channel?: string; status?: "open" | "waiting" | "done"; assignee?: string; q?: string; limit?: number }

export async function listConversations(deps: Deps, a: AuthContext, q: ListQuery): Promise<ConversationSummary[]> {
  await requireEnabled(deps, a);
  const term = q.q?.trim().slice(0, 100);
  const pat = term ? `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const rows = await deps.db.select({ c: msgConversations, provider: msgChannels.provider }).from(msgConversations)
    .innerJoin(msgChannels, eq(msgChannels.id, msgConversations.channelId))
    .where(and(
      eq(msgConversations.orgId, a.orgId),
      q.channel ? eq(msgConversations.channelId, q.channel) : undefined,
      q.status ? eq(msgConversations.status, q.status) : undefined,
      q.assignee === "me" ? eq(msgConversations.assigneeUserId, a.userId) : q.assignee === "none" ? isNull(msgConversations.assigneeUserId) : q.assignee ? eq(msgConversations.assigneeUserId, q.assignee) : undefined,
      pat ? or(
        sql`${msgConversations.contactName} LIKE ${pat} ESCAPE '\\'`, like(msgConversations.contactExternalId, pat),
        sql`EXISTS (SELECT 1 FROM msg_messages mm WHERE mm.conversation_id = ${msgConversations.id} AND mm.text LIKE ${pat} ESCAPE '\\')`,
      ) : undefined,
    ))
    .orderBy(desc(msgConversations.lastMessageAt)).limit(Math.min(Math.max(q.limit ?? 50, 1), 100));
  const names = await namesOf(deps, rows.map((r) => r.c.assigneeUserId));
  return rows.map((r) => summarize(r.c, r.provider, names));
}

async function openConversation(deps: Deps, a: AuthContext, id: string) {
  await requireEnabled(deps, a);
  const row = await deps.db.select({ c: msgConversations, ch: msgChannels }).from(msgConversations)
    .innerJoin(msgChannels, eq(msgChannels.id, msgConversations.channelId))
    .where(and(eq(msgConversations.id, id), eq(msgConversations.orgId, a.orgId))).get();
  if (!row) throw notFound("Conversation");
  return row;
}

const mediaUrl = (m: MsgRow) => (m.mediaB64 || m.mediaKey ? `/api/channels/media/${m.id}` : null);

function toMessage(m: MsgRow, names: Map<string, string>): ChatMessage {
  return {
    id: m.id, direction: m.direction, kind: m.kind as ChatMessage["kind"], text: m.text, date: m.date.toISOString(), delivery: m.delivery, error: m.error,
    media: m.mediaName ? { filename: m.mediaName, contentType: m.mediaType ?? "application/octet-stream", size: m.mediaSize ?? 0, url: mediaUrl(m) } : null,
    sentBy: m.sentByUserId ? { userId: m.sentByUserId, name: names.get(m.sentByUserId) ?? "Teammate" } : null,
    templateName: m.templateName,
  };
}

// The list never reads file bytes.
const MSG_COLS = {
  id: msgMessages.id, orgId: msgMessages.orgId, channelId: msgMessages.channelId, conversationId: msgMessages.conversationId, direction: msgMessages.direction,
  externalId: msgMessages.externalId, kind: msgMessages.kind, text: msgMessages.text, delivery: msgMessages.delivery, error: msgMessages.error,
  mediaName: msgMessages.mediaName, mediaType: msgMessages.mediaType, mediaSize: msgMessages.mediaSize,
  mediaB64: sql<string | null>`CASE WHEN ${msgMessages.mediaB64} IS NULL THEN NULL ELSE '1' END`, mediaKey: msgMessages.mediaKey,
  templateName: msgMessages.templateName, sentByUserId: msgMessages.sentByUserId, date: msgMessages.date, createdAt: msgMessages.createdAt,
};

export async function conversationDetail(deps: Deps, a: AuthContext, id: string): Promise<ConversationDetail> {
  const { c, ch } = await openConversation(deps, a, id);
  const msgs = (await deps.db.select(MSG_COLS).from(msgMessages).where(eq(msgMessages.conversationId, c.id)).orderBy(desc(msgMessages.date)).limit(200)).reverse() as MsgRow[];
  const names = await namesOf(deps, [c.assigneeUserId, ...msgs.map((m) => m.sentByUserId)]);
  return {
    conversation: summarize(c, ch.provider, names), channel: summarizeChannel(ch),
    messages: msgs.map((m) => toMessage(m, names)), window: replyWindow(c.lastInboundAt, deps.now()),
  };
}

export async function patchConversation(deps: Deps, a: AuthContext, id: string, b: { assigneeUserId?: string | null; status?: "open" | "waiting" | "done"; labels?: string[] }) {
  const { c, ch } = await openConversation(deps, a, id);
  const set: Partial<ConvRow> = {};
  if (b.assigneeUserId !== undefined) {
    if (b.assigneeUserId) {
      const m = await deps.db.select({ id: members.id }).from(members).where(and(eq(members.organizationId, a.orgId), eq(members.userId, b.assigneeUserId))).get();
      if (!m) throw new HttpError(422, "validation_failed", "That person is not in this workspace.");
    }
    set.assigneeUserId = b.assigneeUserId;
  }
  if (b.status) set.status = b.status;
  if (b.labels) set.labels = JSON.stringify([...new Set(b.labels.map((l) => l.trim().slice(0, 40)).filter(Boolean))].slice(0, 20));
  if (Object.keys(set).length) await deps.db.update(msgConversations).set(set).where(eq(msgConversations.id, c.id));
  const next = { ...c, ...set };
  return summarize(next, ch.provider, await namesOf(deps, [next.assigneeUserId]));
}

export async function markRead(deps: Deps, a: AuthContext, id: string) {
  const { c } = await openConversation(deps, a, id);
  if (c.unreadCount) await deps.db.update(msgConversations).set({ unreadCount: 0 }).where(eq(msgConversations.id, c.id));
  return { ok: true };
}

// ---- sending -------------------------------------------------------------------------------------------

export const windowClosed = () => new HttpError(409, "window_closed", "More than 24 hours have passed since this customer last wrote, so WhatsApp only allows an approved template. Choose a template to reach them.");

/** One write: the channel shows "Connect again" in Settings and sends stop until an admin reconnects. */
export async function markNeedsReconnect(deps: Deps, channelId: string, why: string) {
  await deps.db.update(msgChannels).set({ status: "error", lastError: why.slice(0, 300) }).where(and(eq(msgChannels.id, channelId), eq(msgChannels.status, "active")));
}

async function storeOutbound(deps: Deps, a: AuthContext, c: ConvRow, ch: ChannelRow, opts: { id?: string; retry?: boolean }, row: Partial<MsgRow>, send: () => Promise<{ externalId: string }>) {
  // Same Idempotency-Key: the retry answers the message the first attempt made instead of sending again.
  if (opts.id && opts.retry) {
    const prior = await deps.db.select(MSG_COLS).from(msgMessages).where(and(eq(msgMessages.id, opts.id), eq(msgMessages.orgId, a.orgId))).get() as MsgRow | undefined;
    if (prior) return toMessage(prior, await namesOf(deps, [prior.sentByUserId]));
  }
  const id = opts.id ?? newId("cm");
  const now = deps.now();
  const base = { id, orgId: a.orgId, channelId: ch.id, conversationId: c.id, direction: "out" as const, kind: "text", text: "", delivery: "pending" as const, sentByUserId: a.userId, date: now, createdAt: now, ...row };
  await deps.db.insert(msgMessages).values(base);
  let externalId: string | null = null, delivery: MsgRow["delivery"] = "sent", error: string | null = null;
  try {
    externalId = (await send()).externalId;
  } catch (e) {
    delivery = "failed";
    error = e instanceof ProviderError ? e.message : e instanceof HttpError ? e.message : "The message could not be sent.";
    if (!(e instanceof ProviderError) && !(e instanceof HttpError)) deps.reportError?.(e, { where: "channels.send" });
    // An expired or revoked token (Meta error 190) will fail every send: show the channel as needing a reconnect.
    if (e instanceof ProviderError && e.code === 190) await markNeedsReconnect(deps, ch.id, e.message);
  }
  await deps.db.update(msgMessages).set({ externalId, delivery, error }).where(eq(msgMessages.id, id));
  await deps.db.update(msgConversations).set({ lastMessageAt: now, snippet: snippetOf(base.kind, base.text || base.mediaName || ""), unreadCount: 0 }).where(eq(msgConversations.id, c.id));
  const saved = { ...base, externalId, delivery, error, mediaB64: base.mediaB64 ? "1" : null } as MsgRow;
  return toMessage(saved, await namesOf(deps, [a.userId]));
}

export async function sendMessage(deps: Deps, a: AuthContext, convId: string, b: { text?: string; file?: { name: string; contentType: string; dataB64: string } }, opts: { id?: string; retry?: boolean } = {}) {
  const { c, ch } = await openConversation(deps, a, convId);
  const text = (b.text ?? "").trim();
  if (!text && !b.file) throw new HttpError(422, "validation_failed", "Write a message or attach a file.");
  if (text.length > TEXT_MAX) throw new HttpError(422, "validation_failed", `Keep a message under ${TEXT_MAX} characters.`);
  if (ch.status !== "active") throw new HttpError(409, "channel_disconnected", "This channel is disconnected. An admin can reconnect it in Settings.");
  if (!replyWindow(c.lastInboundAt, deps.now()).open) throw windowClosed();
  const adapter = adapterFor(deps, ch.provider);
  const creds = await credentialsOf(deps, ch);
  if (b.file) {
    let bytes: Uint8Array;
    try { bytes = fromB64(b.file.dataB64); } catch { throw new HttpError(422, "validation_failed", "That file could not be read."); }
    if (!bytes.byteLength) throw new HttpError(422, "validation_failed", "That file is empty.");
    if (bytes.byteLength > FILE_MAX) throw new HttpError(413, "file_too_large", "Files can be up to 5 MB.");
    const type = b.file.contentType.slice(0, 128) || "application/octet-stream";
    const name = b.file.name.replace(/[\\/\r\n]/g, "_").slice(0, 200) || "file";
    let mediaKey: string | null = null, mediaB64: string | null = null;
    if (bytes.byteLength <= MEDIA_INLINE_MAX) mediaB64 = b.file.dataB64;
    else if (deps.bodyStore) { mediaKey = `chat-media/${a.orgId}/${newId("cm")}`; await deps.bodyStore.put(mediaKey, bytes, type); }
    return storeOutbound(deps, a, c, ch, opts, { kind: mediaTypeFor(type), text, mediaName: name, mediaType: type, mediaSize: bytes.byteLength, mediaB64, mediaKey },
      () => adapter.sendFile(creds, c.contactExternalId, { bytes, contentType: type, filename: name }, text));
  }
  return storeOutbound(deps, a, c, ch, opts, { kind: "text", text }, () => adapter.sendText(creds, c.contactExternalId, text));
}

export async function listTemplates(deps: Deps, a: AuthContext, convId: string): Promise<ChatTemplate[]> {
  const { ch } = await openConversation(deps, a, convId);
  if (ch.status !== "active") return [];
  try {
    return await adapterFor(deps, ch.provider).listTemplates(await credentialsOf(deps, ch));
  } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(502, "provider_refused", e.message);
    throw e;
  }
}

export async function sendTemplate(deps: Deps, a: AuthContext, convId: string, b: { name: string; language: string; params: string[] }, opts: { id?: string; retry?: boolean } = {}) {
  const { c, ch } = await openConversation(deps, a, convId);
  if (ch.status !== "active") throw new HttpError(409, "channel_disconnected", "This channel is disconnected. An admin can reconnect it in Settings.");
  const adapter = adapterFor(deps, ch.provider);
  const creds = await credentialsOf(deps, ch);
  const tpl = (await adapter.listTemplates(creds)).find((t) => t.name === b.name && t.language === b.language);
  if (!tpl) throw new HttpError(422, "validation_failed", "That template is not approved for this number.");
  if (b.params.length !== tpl.params || b.params.some((p) => !p.trim())) throw new HttpError(422, "validation_failed", `Fill in all ${tpl.params} blanks in the template.`);
  const values = b.params.map((p) => p.trim());
  const text = fillTemplateBody(tpl.body, values, tpl.paramNames);
  return storeOutbound(deps, a, c, ch, opts, { kind: "template", text, templateName: tpl.name }, () => adapter.sendTemplate(creds, c.contactExternalId, { name: tpl.name, language: tpl.language, params: values, paramNames: tpl.paramNames }));
}

// ---- notes, tasks, media ---------------------------------------------------------------------------------

export async function listNotes(deps: Deps, a: AuthContext, convId: string) {
  const { c } = await openConversation(deps, a, convId);
  const rows = await deps.db.select().from(threadComments).where(and(eq(threadComments.orgId, a.orgId), eq(threadComments.threadId, c.id))).orderBy(asc(threadComments.createdAt)).limit(200);
  const names = await namesOf(deps, rows.map((r) => r.authorId));
  return { notes: rows.map((r) => ({ id: r.id, body: r.body, author: { id: r.authorId, name: names.get(r.authorId) ?? "Teammate" }, createdAt: r.createdAt.toISOString() })) };
}

export async function addNote(deps: Deps, a: AuthContext, convId: string, body: string) {
  const { c } = await openConversation(deps, a, convId);
  const text = body.trim();
  if (!text) throw new HttpError(422, "validation_failed", "Write a note first.");
  // Notes reuse thread_comments: thread_id is the conversation id and mailbox_id the channel id. Team only.
  const row = { id: sortableId("cmt"), orgId: a.orgId, threadId: c.id, mailboxId: c.channelId, authorType: "member" as const, authorId: a.userId, body: text.slice(0, NOTE_MAX), mentions: "[]", createdAt: deps.now() };
  await deps.db.insert(threadComments).values(row);
  return { id: row.id, body: row.body, author: { id: a.userId, name: a.name || a.email }, createdAt: row.createdAt.toISOString() };
}

export async function taskFromMessage(deps: Deps, a: AuthContext, messageId: string, opts: { id?: string; retry?: boolean } = {}) {
  const m = await deps.db.select({ id: msgMessages.id, conversationId: msgMessages.conversationId, text: msgMessages.text, kind: msgMessages.kind }).from(msgMessages)
    .where(and(eq(msgMessages.id, messageId), eq(msgMessages.orgId, a.orgId))).get();
  if (!m) throw notFound("Message");
  const { c, ch } = await openConversation(deps, a, m.conversationId);
  const who = c.contactName || c.contactExternalId;
  const task = await createTask(deps, a, { title: `Follow up with ${who}`.slice(0, 200), notes: (m.text || snippetOf(m.kind, "")).slice(0, 2000) }, opts);
  // Link back: the conversation id is the task's thread, so the inbox can show the task chip.
  await deps.db.update(tasks).set({ threadId: c.id, sourceFrom: `${who} (${PROVIDER_LABEL[ch.provider]})`.slice(0, 300), sourceSubject: `${PROVIDER_LABEL[ch.provider]} chat` }).where(eq(tasks.id, task.id));
  return task;
}

export async function mediaOf(deps: Deps, a: AuthContext, messageId: string) {
  const m = await deps.db.select().from(msgMessages).where(and(eq(msgMessages.id, messageId), eq(msgMessages.orgId, a.orgId))).get();
  if (!m || !m.mediaName) throw notFound("File");
  await openConversation(deps, a, m.conversationId);
  let bytes: Uint8Array | null = null;
  if (m.mediaB64) bytes = fromB64(m.mediaB64);
  else if (m.mediaKey && deps.bodyStore) bytes = await deps.bodyStore.get(m.mediaKey);
  if (!bytes) throw notFound("File");
  return { bytes, contentType: m.mediaType ?? "application/octet-stream", filename: m.mediaName };
}

// ---- local test provider -------------------------------------------------------------------------------

export async function mockAge(deps: Deps, a: AuthContext, convId: string, hours: number) {
  if (!deps.config.channels.mock) throw notFound("Test channel");
  const { c } = await openConversation(deps, a, convId);
  const shift = hours * 3600_000;
  await deps.db.update(msgConversations).set({ lastInboundAt: c.lastInboundAt ? new Date(c.lastInboundAt.getTime() - shift) : null }).where(eq(msgConversations.id, c.id));
  return { ok: true };
}

export async function mockChannel(deps: Deps, a: AuthContext, channelId: string) {
  if (!deps.config.channels.mock) throw notFound("Test channel");
  const ch = await deps.db.select().from(msgChannels).where(and(eq(msgChannels.id, channelId), eq(msgChannels.orgId, a.orgId), eq(msgChannels.provider, "mock"))).get();
  if (!ch) throw notFound("Test channel");
  return ch;
}
