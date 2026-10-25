/**
 * Team chat: channels and direct messages per workspace, threads, @mentions, file attachments,
 * unread counts and links into tasks, email threads and docs. Clients poll (no socket needed):
 * the channel list with unread counts, and the open channel with ?since=.
 *
 * Who sees what:
 * - people in the workspace see every public channel, plus private channels and DMs they belong to;
 * - API keys (agents and workspace keys) see public channels only, never DMs or private channels;
 * - a guest sees only channels of their project that are shared with guests (guestAccess).
 */
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatChannels, chatFiles, chatMembers, chatMessages, docs, members as orgMembers, messages, projectGuests, tasks, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { isMimeType } from "../../lib/input-checks";
import { actorOf, assertWritable, createdBy, iso, recordWrite, sortableId, type SuiteActor } from "./common";
import { notify } from "./notify";
import { assignees, createTask, link } from "./tasks";
import { emitEvent } from "../developer/webhooks";
import { reactionsFor } from "./chat-reaction-summary";

type ChannelRow = typeof chatChannels.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;
export interface Mention { type: "member" | "agent" | "channel"; id: string; name: string }
export interface ChatLink { type: "task" | "thread" | "doc"; id: string; ref: string | null; title: string; messageId?: string }
/** A guest reading chat: their project and their own identity. */
export interface GuestViewer { orgId: string; projectId: string; guestId: string; name: string }

export const CHAT_FILE_INLINE_LIMIT = 1_000_000;
export const CHAT_FILE_STORED_LIMIT = 10_000_000;
const MAX_ATTACHMENTS = 5;

const notFound = (what = "Channel") => new HttpError(404, "not_found", `${what} not found.`);
const isKey = (a: SuiteActor) => !!(a.agentId || a.apiKeyId);
const cleanName = (n: string) => n.replace(/[\\/\r\n"<>]/g, "_").replace(/^\.+/, "").slice(0, 160) || "file";
const slug = (n: string) => n.trim().toLowerCase().replace(/^#/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// ---------------------------------------------------------------- markup

const MENTION_RE = /<@(member|agent):([A-Za-z0-9_-]{1,64})>/g;
const LINK_RE = /<#(task|thread|doc):([A-Za-z0-9_.@-]{1,200})>/g;

/** The mention and link tokens in a message body, in order, without duplicates. */
export function parseMarkup(body: string) {
  const mentions: { type: "member" | "agent"; id: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const k = `${m[1]}:${m[2]}`;
    if (!seen.has(k)) { seen.add(k); mentions.push({ type: m[1] as "member" | "agent", id: m[2] }); }
  }
  const links: { type: ChatLink["type"]; id: string }[] = [];
  for (const m of body.matchAll(LINK_RE)) {
    const k = `${m[1]}:${m[2]}`;
    if (!seen.has(k)) { seen.add(k); links.push({ type: m[1] as ChatLink["type"], id: m[2] }); }
  }
  return { mentions, links, everyone: /<!channel>|<!here>/.test(body) };
}

/** Plain text for previews, task titles and push-free summaries: tokens become names. */
export function plainText(body: string, mentions: Mention[] = [], links: ChatLink[] = []) {
  const names = new Map(mentions.map((m) => [`${m.type}:${m.id}`, m.name]));
  const titles = new Map(links.map((l) => [`${l.type}:${l.id}`, l.ref ?? l.title]));
  return body
    .replace(MENTION_RE, (_, t, id) => `@${names.get(`${t}:${id}`) ?? "someone"}`)
    .replace(LINK_RE, (_, t, id) => titles.get(`${t}:${id}`) ?? t)
    .replace(/<!(channel|here)>/g, "@channel")
    .trim();
}

// ---------------------------------------------------------------- channels

async function peopleOf(deps: Deps, orgId: string) {
  const list = await assignees(deps, orgId);
  return new Map(list.map((p) => [p.id, p]));
}

async function membersOf(deps: Deps, channelIds: string[]) {
  if (!channelIds.length) return new Map<string, { id: string; name: string; email: string; lastReadAt: Date | null }[]>();
  const rows = await deps.db.select({ channelId: chatMembers.channelId, userId: chatMembers.userId, lastReadAt: chatMembers.lastReadAt, name: users.name, email: users.email })
    .from(chatMembers).innerJoin(users, eq(users.id, chatMembers.userId)).where(inArray(chatMembers.channelId, channelIds));
  const out = new Map<string, { id: string; name: string; email: string; lastReadAt: Date | null }[]>();
  for (const r of rows) {
    const l = out.get(r.channelId) ?? [];
    l.push({ id: r.userId, name: r.name, email: r.email, lastReadAt: r.lastReadAt });
    out.set(r.channelId, l);
  }
  return out;
}

function presentChannel(c: ChannelRow, viewerId: string | null, members: { id: string; name: string; email: string }[], extra: { unread?: number; mentions?: number; lastMessage?: { id: string; preview: string; authorName: string } | null } = {}) {
  const others = members.filter((m) => m.id !== viewerId);
  return {
    id: c.id, kind: c.kind, name: c.kind === "dm" ? (others.map((m) => m.name || m.email).join(", ") || "Just you") : c.name,
    topic: c.topic, private: c.isPrivate, projectId: c.projectId, guestAccess: c.guestAccess, archived: c.archived,
    joined: viewerId ? members.some((m) => m.id === viewerId) : false,
    members: members.map((m) => ({ id: `member:${m.id}`, name: m.name, email: m.email })),
    unread: extra.unread ?? 0, mentions: extra.mentions ?? 0, lastMessageAt: iso(c.lastMessageAt), lastMessage: extra.lastMessage ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}
export type Channel = ReturnType<typeof presentChannel>;

async function channelRow(deps: Deps, orgId: string, id: string) {
  const c = await deps.db.select().from(chatChannels).where(and(eq(chatChannels.orgId, orgId), eq(chatChannels.id, id), isNull(chatChannels.deletedAt))).get();
  if (!c) throw notFound();
  return c;
}

async function isMember(deps: Deps, channelId: string, userId: string) {
  return !!(await deps.db.select({ u: chatMembers.userId }).from(chatMembers).where(and(eq(chatMembers.channelId, channelId), eq(chatMembers.userId, userId))).get());
}

/** The channel if this actor may read it, else a 404 (never a hint that it exists). */
export async function visibleChannel(deps: Deps, a: SuiteActor, id: string) {
  const c = await channelRow(deps, a.orgId, id);
  if (c.kind === "dm" || c.isPrivate) {
    if (isKey(a) || !a.userId || !(await isMember(deps, c.id, a.userId))) throw notFound();
  }
  return c;
}

/** Makes #general the first time anyone in a workspace opens chat. */
async function ensureGeneral(deps: Deps, a: SuiteActor) {
  const any = await deps.db.select({ id: chatChannels.id }).from(chatChannels).where(and(eq(chatChannels.orgId, a.orgId), eq(chatChannels.kind, "channel"), eq(chatChannels.isPrivate, false))).limit(1).get();
  if (any) return;
  const now = deps.now();
  const id = sortableId("chn", now.getTime());
  await deps.db.insert(chatChannels).values({ id, orgId: a.orgId, kind: "channel", name: "general", topic: "Everyone in the workspace", createdAt: now, updatedAt: now, ...createdBy(a) }).onConflictDoNothing();
  if (a.userId && !isKey(a)) await deps.db.insert(chatMembers).values({ channelId: id, userId: a.userId, orgId: a.orgId, lastReadAt: now, joinedAt: now }).onConflictDoNothing();
}

async function unreadFor(deps: Deps, orgId: string, userId: string) {
  const rows = await deps.db.select({
    channelId: chatMessages.channelId,
    unread: sql<number>`count(*)`,
    mentions: sql<number>`sum(case when ${chatMessages.mentionKeys} like ${`%member:${userId}%`} or ${chatMessages.mentionKeys} like '%channel%' then 1 else 0 end)`,
  }).from(chatMessages)
    .innerJoin(chatMembers, and(eq(chatMembers.channelId, chatMessages.channelId), eq(chatMembers.userId, userId)))
    .where(and(eq(chatMessages.orgId, orgId), isNull(chatMessages.parentId), isNull(chatMessages.deletedAt),
      sql`${chatMessages.createdAt} > coalesce(${chatMembers.lastReadAt}, 0)`, sql`coalesce(${chatMessages.authorId}, '') <> ${userId}`))
    .groupBy(chatMessages.channelId);
  return new Map(rows.map((r) => [r.channelId, { unread: Number(r.unread) || 0, mentions: Number(r.mentions) || 0 }]));
}

export async function listChannels(deps: Deps, a: SuiteActor, opts: { includeArchived?: boolean } = {}) {
  await ensureGeneral(deps, a);
  const viewer = isKey(a) ? null : a.userId;
  const mine = viewer ? (await deps.db.select({ id: chatMembers.channelId }).from(chatMembers).where(and(eq(chatMembers.userId, viewer), eq(chatMembers.orgId, a.orgId)))).map((r) => r.id) : [];
  const visible = or(and(eq(chatChannels.kind, "channel"), eq(chatChannels.isPrivate, false)), mine.length ? inArray(chatChannels.id, mine) : sql`0`);
  const rows = await deps.db.select().from(chatChannels)
    .where(and(eq(chatChannels.orgId, a.orgId), isNull(chatChannels.deletedAt), visible, opts.includeArchived ? undefined : eq(chatChannels.archived, false)))
    .orderBy(asc(chatChannels.kind), asc(chatChannels.name));
  const ids = rows.map((r) => r.id);
  const [mem, unread, last] = await Promise.all([
    membersOf(deps, ids),
    viewer ? unreadFor(deps, a.orgId, viewer) : Promise.resolve(new Map<string, { unread: number; mentions: number }>()),
    ids.length ? deps.db.select().from(chatMessages).where(inArray(chatMessages.id,
      deps.db.select({ id: sql<string>`max(${chatMessages.id})` }).from(chatMessages).where(and(inArray(chatMessages.channelId, ids), isNull(chatMessages.parentId), isNull(chatMessages.deletedAt))).groupBy(chatMessages.channelId))) : Promise.resolve([] as MessageRow[]),
  ]);
  const lastBy = new Map(last.map((m) => [m.channelId, { id: m.id, preview: plainText(m.body, JSON.parse(m.mentions), JSON.parse(m.links)).slice(0, 140), authorName: m.authorName }]));
  const out = rows.map((r) => presentChannel(r, viewer, mem.get(r.id) ?? [], { ...(unread.get(r.id) ?? {}), lastMessage: lastBy.get(r.id) ?? null }));
  // DMs with recent messages first, channels by name.
  return out.sort((x, y) => (x.kind !== y.kind ? (x.kind === "channel" ? -1 : 1) : x.kind === "dm" ? (y.lastMessageAt ?? "").localeCompare(x.lastMessageAt ?? "") : x.name.localeCompare(y.name)));
}

export async function getChannel(deps: Deps, a: SuiteActor, id: string) {
  const c = await visibleChannel(deps, a, id);
  const viewer = isKey(a) ? null : a.userId;
  const [mem, unread] = await Promise.all([membersOf(deps, [c.id]), viewer ? unreadFor(deps, a.orgId, viewer) : Promise.resolve(new Map())]);
  return presentChannel(c, viewer, mem.get(c.id) ?? [], unread.get(c.id) ?? {});
}

async function orgUserIds(deps: Deps, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  const people = await peopleOf(deps, orgId);
  const bad = ids.filter((id) => !people.has(`member:${id.replace(/^member:/, "")}`));
  if (bad.length) throw new HttpError(422, "validation_failed", "Everyone added must be a member of this workspace.");
  return [...new Set(ids.map((id) => id.replace(/^member:/, "")))];
}

export async function createChannel(deps: Deps, a: SuiteActor, input: { name: string; topic?: string; private?: boolean; memberIds?: string[]; projectId?: string | null; guestAccess?: boolean }) {
  assertWritable(a);
  const name = slug(input.name);
  if (!name) throw new HttpError(422, "validation_failed", "Give the channel a name with letters or numbers.");
  if (input.private && isKey(a)) throw new HttpError(403, "forbidden", "API keys can make public channels only.");
  const clash = await deps.db.select({ id: chatChannels.id }).from(chatChannels).where(and(eq(chatChannels.orgId, a.orgId), eq(chatChannels.kind, "channel"), eq(chatChannels.name, name), isNull(chatChannels.deletedAt))).get();
  if (clash) throw new HttpError(409, "name_taken", `There is already a #${name} channel.`);
  if (input.projectId) await projectInOrg(deps, a.orgId, input.projectId);
  const memberIds = await orgUserIds(deps, a.orgId, input.memberIds ?? []);
  const now = deps.now();
  const id = sortableId("chn", now.getTime());
  await deps.db.insert(chatChannels).values({
    id, orgId: a.orgId, kind: "channel", name, topic: (input.topic ?? "").slice(0, 250), isPrivate: !!input.private,
    projectId: input.projectId ?? null, guestAccess: !!(input.projectId && input.guestAccess), createdAt: now, updatedAt: now, ...createdBy(a),
  });
  const join = new Set(memberIds);
  if (a.userId && !isKey(a)) join.add(a.userId);
  if (join.size) await deps.db.insert(chatMembers).values([...join].map((u) => ({ channelId: id, userId: u, orgId: a.orgId, lastReadAt: now, joinedAt: now }))).onConflictDoNothing();
  const ch = await getChannel(deps, a, id);
  await recordWrite(deps, a, { entityType: "channel", entityId: id, op: "create", verb: "created", data: { name }, event: "chat.channel.created", eventData: { channel: { id, name, private: ch.private, projectId: ch.projectId } } });
  return ch;
}

async function projectInOrg(deps: Deps, orgId: string, projectId: string) {
  const { projects } = await import("../../db/schema");
  const p = await deps.db.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId))).get();
  if (!p) throw new HttpError(422, "validation_failed", "That project isn't in this workspace.");
}

/** Finds the DM between exactly these people (plus the caller), or starts it. */
export async function openDm(deps: Deps, a: SuiteActor, userIds: string[]) {
  assertWritable(a);
  if (isKey(a) || !a.userId) throw new HttpError(403, "forbidden", "Direct messages are between people.");
  const ids = await orgUserIds(deps, a.orgId, userIds);
  const all = [...new Set([...ids, a.userId])].sort();
  if (all.length > 9) throw new HttpError(422, "validation_failed", "A direct message can have up to 9 people. Make a private channel instead.");
  const dmKey = all.join(",");
  const existing = await deps.db.select().from(chatChannels).where(and(eq(chatChannels.orgId, a.orgId), eq(chatChannels.dmKey, dmKey))).get();
  if (existing) return { channel: await getChannel(deps, a, existing.id), created: false };
  const now = deps.now();
  const id = sortableId("chn", now.getTime());
  await deps.db.insert(chatChannels).values({ id, orgId: a.orgId, kind: "dm", name: "", isPrivate: true, dmKey, createdAt: now, updatedAt: now, ...createdBy(a) }).onConflictDoNothing();
  const row = await deps.db.select().from(chatChannels).where(and(eq(chatChannels.orgId, a.orgId), eq(chatChannels.dmKey, dmKey))).get();
  await deps.db.insert(chatMembers).values(all.map((u) => ({ channelId: row!.id, userId: u, orgId: a.orgId, lastReadAt: now, joinedAt: now }))).onConflictDoNothing();
  return { channel: await getChannel(deps, a, row!.id), created: true };
}

export async function updateChannel(deps: Deps, a: SuiteActor, id: string, patch: { name?: string; topic?: string; archived?: boolean; guestAccess?: boolean; projectId?: string | null }) {
  assertWritable(a);
  const c = await visibleChannel(deps, a, id);
  if (c.kind === "dm") throw new HttpError(422, "validation_failed", "A direct message has no settings.");
  const set: Partial<ChannelRow> = { updatedAt: deps.now(), version: c.version + 1 };
  if (patch.name !== undefined) {
    const name = slug(patch.name);
    if (!name) throw new HttpError(422, "validation_failed", "Give the channel a name with letters or numbers.");
    const clash = await deps.db.select({ id: chatChannels.id }).from(chatChannels).where(and(eq(chatChannels.orgId, a.orgId), eq(chatChannels.kind, "channel"), eq(chatChannels.name, name), isNull(chatChannels.deletedAt))).get();
    if (clash && clash.id !== c.id) throw new HttpError(409, "name_taken", `There is already a #${name} channel.`);
    set.name = name;
  }
  if (patch.topic !== undefined) set.topic = patch.topic.slice(0, 250);
  if (patch.archived !== undefined) set.archived = patch.archived;
  if (patch.projectId !== undefined) { if (patch.projectId) await projectInOrg(deps, a.orgId, patch.projectId); set.projectId = patch.projectId; if (!patch.projectId) set.guestAccess = false; }
  if (patch.guestAccess !== undefined) {
    if (patch.guestAccess && c.isPrivate) throw new HttpError(422, "validation_failed", "Share a public project channel with guests, not a private one.");
    if (patch.guestAccess && !(set.projectId ?? c.projectId)) throw new HttpError(422, "validation_failed", "Link the channel to a project first: its guests are who can see it.");
    set.guestAccess = patch.guestAccess;
  }
  await deps.db.update(chatChannels).set(set).where(eq(chatChannels.id, c.id));
  await recordWrite(deps, a, { entityType: "channel", entityId: c.id, op: "update", version: c.version + 1, verb: "updated", data: { fields: Object.keys(patch) } });
  return getChannel(deps, a, c.id);
}

export async function joinChannel(deps: Deps, a: SuiteActor, id: string) {
  if (isKey(a) || !a.userId) throw new HttpError(403, "forbidden", "People join channels; agents can read and post in public channels without joining.");
  const c = await visibleChannel(deps, a, id);
  const now = deps.now();
  await deps.db.insert(chatMembers).values({ channelId: c.id, userId: a.userId, orgId: a.orgId, lastReadAt: now, joinedAt: now }).onConflictDoNothing();
  return getChannel(deps, a, c.id);
}

export async function leaveChannel(deps: Deps, a: SuiteActor, id: string) {
  const c = await visibleChannel(deps, a, id);
  if (c.kind === "dm") throw new HttpError(422, "validation_failed", "You can't leave a direct message.");
  await deps.db.delete(chatMembers).where(and(eq(chatMembers.channelId, c.id), eq(chatMembers.userId, a.userId)));
  return { ok: true };
}

export async function addMembers(deps: Deps, a: SuiteActor, id: string, userIds: string[]) {
  assertWritable(a);
  const c = await visibleChannel(deps, a, id);
  if (c.kind === "dm") throw new HttpError(422, "validation_failed", "Start a new direct message to add people.");
  const ids = await orgUserIds(deps, a.orgId, userIds);
  const now = deps.now();
  if (ids.length) await deps.db.insert(chatMembers).values(ids.map((u) => ({ channelId: c.id, userId: u, orgId: a.orgId, lastReadAt: null, joinedAt: now }))).onConflictDoNothing();
  return getChannel(deps, a, c.id);
}

// ---------------------------------------------------------------- messages

/**
 * A short-lived link to one file that works without a session, for phones that open files in
 * the system browser. The expiry is rounded to the next 15 minutes so links stay cacheable,
 * and is never less than 15 minutes away.
 */
const FILE_LINK_MS = 15 * 60_000;
async function fileSig(deps: Deps, orgId: string, fileId: string, exp: number) {
  const { hmacSha256Hex } = await import("../../lib/crypto");
  return hmacSha256Hex(deps.config.appSecret, `chat-file:${orgId}:${fileId}:${exp}`);
}
export async function signedFileUrl(deps: Deps, orgId: string, fileId: string) {
  const exp = Math.ceil((deps.now().getTime() + FILE_LINK_MS) / FILE_LINK_MS) * FILE_LINK_MS;
  return `/api/chat/files/${fileId}/download?exp=${exp}&sig=${await fileSig(deps, orgId, fileId, exp)}`;
}
export async function readSignedChatFile(deps: Deps, fileId: string, exp: string | undefined, sig: string | undefined) {
  const at = Number(exp);
  if (!sig || !Number.isFinite(at) || at < deps.now().getTime()) throw notFound("File");
  const f = await deps.db.select().from(chatFiles).where(eq(chatFiles.id, fileId)).get();
  if (!f) throw notFound("File");
  const want = await fileSig(deps, f.orgId, f.id, at);
  if (want.length !== sig.length || !timingSafeEqualStr(want, sig)) throw notFound("File");
  let bytes: Uint8Array | null = null;
  if (f.contentB64) { const { fromB64 } = await import("../../lib/crypto"); bytes = fromB64(f.contentB64); }
  else if (f.storageKey && deps.bodyStore) bytes = await deps.bodyStore.get(f.storageKey);
  if (!bytes) throw notFound("File");
  return { filename: f.filename, contentType: f.contentType, bytes };
}
function timingSafeEqualStr(a: string, b: string) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function filesFor(deps: Deps, messageIds: string[]) {
  const out = new Map<string, { id: string; filename: string; contentType: string; size: number; url: string }[]>();
  if (!messageIds.length) return out;
  const rows = await deps.db.select({ id: chatFiles.id, orgId: chatFiles.orgId, messageId: chatFiles.messageId, filename: chatFiles.filename, contentType: chatFiles.contentType, size: chatFiles.sizeBytes })
    .from(chatFiles).where(inArray(chatFiles.messageId, messageIds)).orderBy(asc(chatFiles.id));
  for (const r of rows) { const l = out.get(r.messageId) ?? []; l.push({ id: r.id, filename: r.filename, contentType: r.contentType, size: r.size, url: await signedFileUrl(deps, r.orgId, r.id) }); out.set(r.messageId, l); }
  return out;
}

type AuthorInfo = { title: string | null; agent: boolean };
function presentMessage(m: MessageRow, files: { id: string; filename: string; contentType: string; size: number; url?: string }[] = [], who?: AuthorInfo) {
  const deleted = !!m.deletedAt;
  return {
    id: m.id, channelId: m.channelId, parentId: m.parentId,
    // `title` and `agent` come from the author's membership: an AI agent member shows its title and an agent label.
    author: { type: m.authorType, id: m.authorId, name: m.authorName, title: who?.title ?? null, agent: m.authorType === "agent" || !!who?.agent },
    body: deleted ? "" : m.body, mentions: deleted ? [] : (JSON.parse(m.mentions) as Mention[]), links: deleted ? [] : (JSON.parse(m.links) as ChatLink[]),
    attachments: deleted ? [] : files, replyCount: m.replyCount, lastReplyAt: iso(m.lastReplyAt), editedAt: iso(m.editedAt), deleted,
    pinnedAt: deleted ? null : iso(m.pinnedAt), pinnedBy: deleted ? null : m.pinnedBy ?? null,
    createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
  };
}
export type ChatMessage = ReturnType<typeof presentMessage>;

/** Titles and agent flags of the member authors on a page, in one query. */
async function authorInfo(deps: Deps, rows: MessageRow[]): Promise<Map<string, AuthorInfo>> {
  const out = new Map<string, AuthorInfo>();
  const ids = [...new Set(rows.filter((r) => r.authorType === "member" && r.authorId).map((r) => r.authorId!))];
  if (!ids.length) return out;
  const found = await deps.db.select({ userId: orgMembers.userId, title: orgMembers.title, kind: orgMembers.kind }).from(orgMembers)
    .where(and(eq(orgMembers.organizationId, rows[0].orgId), inArray(orgMembers.userId, ids)));
  for (const m of found) out.set(m.userId, { title: m.title ?? null, agent: m.kind === "agent" });
  return out;
}

async function present(deps: Deps, rows: MessageRow[]) {
  const files = await filesFor(deps, rows.map((r) => r.id));
  const who = await authorInfo(deps, rows);
  // Round 20: reactions ride along on every read, so the existing chat poll shows them to others.
  const reactions = await reactionsFor(deps, rows.filter((r) => !r.deletedAt).map((r) => r.id));
  return rows.map((r) => ({ ...presentMessage(r, files.get(r.id), r.authorId ? who.get(r.authorId) : undefined), reactions: reactions.get(r.id) ?? [] }));
}

export async function listMessages(deps: Deps, channelId: string, q: { limit?: number; before?: string; since?: string }) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  if (q.since) {
    const since = new Date(q.since);
    if (Number.isNaN(since.getTime())) throw new HttpError(422, "validation_failed", "since must be an ISO date-time.");
    const rows = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.channelId, channelId), isNull(chatMessages.parentId), gt(chatMessages.updatedAt, since)))
      .orderBy(asc(chatMessages.createdAt)).limit(limit);
    return { messages: await present(deps, rows), hasMore: rows.length === limit };
  }
  const rows = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.channelId, channelId), isNull(chatMessages.parentId), q.before ? lt(chatMessages.id, q.before) : undefined))
    .orderBy(desc(chatMessages.id)).limit(limit + 1);
  const hasMore = rows.length > limit;
  return { messages: await present(deps, rows.slice(0, limit).reverse()), hasMore };
}

export async function channelMessages(deps: Deps, a: SuiteActor, channelId: string, q: { limit?: number; before?: string; since?: string }) {
  const c = await visibleChannel(deps, a, channelId);
  return listMessages(deps, c.id, q);
}

async function messageRow(deps: Deps, orgId: string, id: string) {
  const m = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.id, id))).get();
  if (!m) throw notFound("Message");
  return m;
}

export async function getMessage(deps: Deps, a: SuiteActor, id: string) {
  const m = await messageRow(deps, a.orgId, id);
  const channel = await getChannel(deps, a, m.channelId);
  return { message: (await present(deps, [m]))[0], channel };
}

export async function threadOf(deps: Deps, orgId: string, m: MessageRow) {
  const root = m.parentId ? await messageRow(deps, orgId, m.parentId) : m;
  const replies = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.channelId, root.channelId), eq(chatMessages.parentId, root.id))).orderBy(asc(chatMessages.createdAt)).limit(500);
  const [rootP, ...rest] = await present(deps, [root, ...replies]);
  return { message: rootP, replies: rest };
}

export async function getThread(deps: Deps, a: SuiteActor, id: string) {
  const m = await messageRow(deps, a.orgId, id);
  await visibleChannel(deps, a, m.channelId);
  return threadOf(deps, a.orgId, m);
}

async function resolveLinks(deps: Deps, a: SuiteActor, raw: { type: ChatLink["type"]; id: string }[]): Promise<ChatLink[]> {
  const out: ChatLink[] = [];
  for (const l of raw.slice(0, 20)) {
    if (l.type === "task") {
      const { resolveTaskId } = await import("./tasks");
      let id: string;
      try { id = await resolveTaskId(deps, a.orgId, l.id); } catch { continue; }
      const t = await deps.db.select({ id: tasks.id, title: tasks.title, number: tasks.number, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.orgId, a.orgId), eq(tasks.id, id))).get();
      if (!t) continue;
      const { projects } = await import("../../db/schema");
      const p = await deps.db.select({ key: projects.key }).from(projects).where(eq(projects.id, t.projectId)).get();
      out.push({ type: "task", id: t.id, ref: p ? `${p.key}-${t.number}` : null, title: t.title });
    } else if (l.type === "thread") {
      const m = await deps.db.select({ id: messages.id, subject: messages.subject }).from(messages).where(and(eq(messages.orgId, a.orgId), eq(messages.threadId, l.id))).orderBy(desc(messages.date)).limit(1).get();
      if (m) out.push({ type: "thread", id: l.id, ref: null, title: m.subject || "(no subject)", messageId: m.id });
    } else {
      const d = await deps.db.select({ id: docs.id, title: docs.title }).from(docs).where(and(eq(docs.orgId, a.orgId), eq(docs.id, l.id), isNull(docs.deletedAt))).get();
      if (d) out.push({ type: "doc", id: d.id, ref: null, title: d.title || "Untitled doc" });
    }
  }
  return out;
}

type Author = { type: "member" | "agent" | "guest" | "system"; id: string | null; name: string };
type Upload = { name: string; type: string; bytes: Uint8Array };

async function storeFiles(deps: Deps, orgId: string, channelId: string, messageId: string, files: Upload[]) {
  const store = deps.bodyStore;
  const limit = store ? CHAT_FILE_STORED_LIMIT : CHAT_FILE_INLINE_LIMIT;
  for (const f of files) {
    if (!f.bytes.length) throw new HttpError(422, "validation_failed", "That file is empty.");
    if (f.bytes.length > limit) throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(limit / 1_000_000)} MB here.`);
  }
  const { toB64 } = await import("../../lib/crypto");
  let i = 0;
  for (const f of files) {
    const id = sortableId("chf", deps.now().getTime() + i++);
    const contentType = isMimeType(f.type) ? f.type.slice(0, 100) : "application/octet-stream";
    let contentB64: string | null = null, storageKey: string | null = null;
    if (f.bytes.length > CHAT_FILE_INLINE_LIMIT && store) { storageKey = `chat-files/${orgId}/${id}`; await store.put(storageKey, f.bytes, contentType); }
    else contentB64 = toB64(f.bytes);
    await deps.db.insert(chatFiles).values({ id, orgId, channelId, messageId, filename: cleanName(f.name), contentType, sizeBytes: f.bytes.length, contentB64, storageKey, createdAt: deps.now() });
  }
}

/** The one write path for a new message, shared by people, agents and guests. */
async function writeMessage(deps: Deps, a: SuiteActor, c: ChannelRow, author: Author, input: { body: string; parentId?: string | null; files?: Upload[] }) {
  const body = (input.body ?? "").trim();
  const files = input.files ?? [];
  if (!body && !files.length) throw new HttpError(422, "validation_failed", "Write a message or attach a file.");
  if (body.length > 20_000) throw new HttpError(422, "validation_failed", "Messages can be up to 20,000 characters.");
  if (files.length > MAX_ATTACHMENTS) throw new HttpError(422, "validation_failed", `Attach up to ${MAX_ATTACHMENTS} files at a time.`);
  if (c.archived) throw new HttpError(409, "archived", "This channel is archived. Unarchive it to post.");
  let parent: MessageRow | null = null;
  if (input.parentId) {
    parent = await messageRow(deps, c.orgId, input.parentId);
    if (parent.channelId !== c.id) throw notFound("Message");
    if (parent.parentId) parent = await messageRow(deps, c.orgId, parent.parentId);
  }
  const parsed = parseMarkup(body);
  const people = await peopleOf(deps, c.orgId);
  const mentions: Mention[] = parsed.mentions.map((m) => people.get(`${m.type}:${m.id}`)).filter(Boolean).map((p) => ({ type: p!.type, id: p!.id.split(":")[1], name: p!.name }));
  if (parsed.everyone) mentions.push({ type: "channel", id: c.id, name: "channel" });
  const links = await resolveLinks(deps, a, parsed.links);
  const now = deps.now();
  const id = sortableId("chm", now.getTime());
  await deps.db.insert(chatMessages).values({
    id, orgId: c.orgId, channelId: c.id, parentId: parent?.id ?? null, authorType: author.type, authorId: author.id, authorName: author.name.slice(0, 120),
    body, mentions: JSON.stringify(mentions), mentionKeys: mentions.map((m) => (m.type === "channel" ? "channel" : `${m.type}:${m.id}`)).join(" "),
    links: JSON.stringify(links), createdAt: now, updatedAt: now,
  });
  if (files.length) await storeFiles(deps, c.orgId, c.id, id, files);
  if (parent) await deps.db.update(chatMessages).set({ replyCount: sql`${chatMessages.replyCount} + 1`, lastReplyAt: now, updatedAt: now }).where(eq(chatMessages.id, parent.id));
  else await deps.db.update(chatChannels).set({ lastMessageAt: now }).where(eq(chatChannels.id, c.id));
  // The author has read everything up to their own message.
  if (author.type === "member" && author.id) await deps.db.update(chatMembers).set({ lastReadAt: now }).where(and(eq(chatMembers.channelId, c.id), eq(chatMembers.userId, author.id)));
  const m = (await present(deps, [(await messageRow(deps, c.orgId, id))]))[0];
  await afterPost(deps, c, m, parent, author);
  return m;
}

/** Inbox entries, pushes and webhooks for a new message. */
async function afterPost(deps: Deps, c: ChannelRow, m: ChatMessage, parent: MessageRow | null, author: Author) {
  const authorUser = author.type === "member" ? author.id : null;
  const members = (await deps.db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.channelId, c.id))).map((r) => r.userId);
  const canSee = (u: string) => (c.kind === "dm" || c.isPrivate ? members.includes(u) : true);
  const preview = plainText(m.body, m.mentions, m.links).slice(0, 120) || (m.attachments.length ? `${m.attachments.length} file(s)` : "");
  const where = c.kind === "dm" ? "a direct message" : `#${c.name}`;
  const told = new Set<string>();
  const tell = async (userId: string, type: string, title: string) => {
    if (!userId || userId === authorUser || told.has(userId) || !canSee(userId)) return;
    told.add(userId);
    await notify(deps, c.orgId, userId, { type, entityType: "chat_message", entityId: m.id, title, actorName: author.name });
  };
  const everyone = m.mentions.some((x) => x.type === "channel");
  for (const x of m.mentions) if (x.type === "member") await tell(x.id, "chat.mention", `${author.name} mentioned you in ${where}: ${preview}`);
  if (everyone) for (const u of members) await tell(u, "chat.mention", `${author.name} in ${where}: ${preview}`);
  if (parent) {
    const repliers = (await deps.db.select({ authorId: chatMessages.authorId }).from(chatMessages).where(and(eq(chatMessages.parentId, parent.id), eq(chatMessages.authorType, "member")))).map((r) => r.authorId);
    for (const u of new Set([parent.authorType === "member" ? parent.authorId : null, ...repliers])) if (u) await tell(u, "chat.reply", `${author.name} replied in a thread in ${where}: ${preview}`);
  }
  if (c.kind === "dm") for (const u of members) await tell(u, "chat.dm", `${author.name}: ${preview}`);
  const channel = { id: c.id, kind: c.kind, name: c.kind === "dm" ? null : c.name };
  await emitEvent(deps, c.orgId, "chat.message.created", { message: m, channel });
  const agentMentions = m.mentions.filter((x) => x.type === "agent");
  if (agentMentions.length) await emitEvent(deps, c.orgId, "chat.mention", { message: m, channel, agents: agentMentions.map((x) => ({ id: x.id, name: x.name })) });
}

export async function postMessage(deps: Deps, a: SuiteActor, channelId: string, input: { body: string; parentId?: string | null; files?: Upload[] }) {
  assertWritable(a);
  const c = await visibleChannel(deps, a, channelId);
  const who = actorOf(a);
  // People who post in a public channel join it, so they see its unread count from then on.
  if (who.type === "member" && who.id && !isKey(a) && c.kind === "channel" && !c.isPrivate) {
    await deps.db.insert(chatMembers).values({ channelId: c.id, userId: who.id, orgId: a.orgId, lastReadAt: deps.now(), joinedAt: deps.now() }).onConflictDoNothing();
  }
  return writeMessage(deps, a, c, { type: who.type === "system" ? "system" : who.type, id: who.id, name: who.name || "Someone" }, input);
}

export async function editMessage(deps: Deps, a: SuiteActor, id: string, body: string) {
  assertWritable(a);
  const m = await messageRow(deps, a.orgId, id);
  await visibleChannel(deps, a, m.channelId);
  const who = actorOf(a);
  if (m.deletedAt || m.authorType !== who.type || m.authorId !== who.id) throw new HttpError(403, "forbidden", "Only the author can edit a message.");
  const text = body.trim();
  if (!text) throw new HttpError(422, "validation_failed", "A message can't be empty. Delete it instead.");
  const parsed = parseMarkup(text);
  const people = await peopleOf(deps, a.orgId);
  const mentions: Mention[] = parsed.mentions.map((x) => people.get(`${x.type}:${x.id}`)).filter(Boolean).map((p) => ({ type: p!.type, id: p!.id.split(":")[1], name: p!.name }));
  if (parsed.everyone) mentions.push({ type: "channel", id: m.channelId, name: "channel" });
  const links = await resolveLinks(deps, a, parsed.links);
  const now = deps.now();
  await deps.db.update(chatMessages).set({ body: text, mentions: JSON.stringify(mentions), mentionKeys: mentions.map((x) => (x.type === "channel" ? "channel" : `${x.type}:${x.id}`)).join(" "), links: JSON.stringify(links), editedAt: now, updatedAt: now }).where(eq(chatMessages.id, m.id));
  const out = (await present(deps, [await messageRow(deps, a.orgId, id)]))[0];
  await emitEvent(deps, a.orgId, "chat.message.updated", { message: out });
  return out;
}

export async function deleteMessage(deps: Deps, a: SuiteActor, id: string) {
  assertWritable(a);
  const m = await messageRow(deps, a.orgId, id);
  await visibleChannel(deps, a, m.channelId);
  const who = actorOf(a);
  const own = m.authorType === who.type && m.authorId === who.id;
  if (!own && !(a.role === "owner" || a.role === "admin") ) throw new HttpError(403, "forbidden", "Only the author or an admin can delete a message.");
  const now = deps.now();
  await deps.db.update(chatMessages).set({ deletedAt: now, updatedAt: now, body: "", mentions: "[]", mentionKeys: "", links: "[]" }).where(eq(chatMessages.id, m.id));
  await deps.db.delete(chatFiles).where(eq(chatFiles.messageId, m.id));
  await emitEvent(deps, a.orgId, "chat.message.deleted", { messageId: m.id, channelId: m.channelId });
  return { ok: true };
}

export const MAX_PINS = 50;

/**
 * Pins a top level message to the top of its channel, or unpins it. Anyone who can post in the
 * channel can pin. One write; updatedAt moves so open chats pick the change up when they poll.
 */
export async function pinMessage(deps: Deps, a: SuiteActor, id: string, pinned: boolean) {
  assertWritable(a);
  const m = await messageRow(deps, a.orgId, id);
  await visibleChannel(deps, a, m.channelId);
  if (m.deletedAt) throw notFound("Message");
  if (m.parentId) throw new HttpError(422, "validation_failed", "Pin the thread's first message instead of a reply.");
  if (pinned === !!m.pinnedAt) return (await present(deps, [m]))[0];
  if (pinned) {
    const n = await deps.db.select({ n: count() }).from(chatMessages).where(and(eq(chatMessages.channelId, m.channelId), isNotNull(chatMessages.pinnedAt), isNull(chatMessages.deletedAt))).get();
    if ((n?.n ?? 0) >= MAX_PINS) throw new HttpError(422, "too_many_pins", `A channel holds up to ${MAX_PINS} pinned messages. Unpin one first.`);
  }
  const now = deps.now();
  await deps.db.update(chatMessages).set(pinned ? { pinnedAt: now, pinnedBy: actorOf(a).name || "Someone", updatedAt: now } : { pinnedAt: null, pinnedBy: null, updatedAt: now }).where(eq(chatMessages.id, m.id));
  const out = (await present(deps, [await messageRow(deps, a.orgId, id)]))[0];
  await emitEvent(deps, a.orgId, "chat.message.updated", { message: out });
  return out;
}

/** The pinned messages of a channel, newest pin first. */
export async function listPins(deps: Deps, a: SuiteActor, channelId: string) {
  const c = await visibleChannel(deps, a, channelId);
  const rows = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.channelId, c.id), isNotNull(chatMessages.pinnedAt), isNull(chatMessages.deletedAt)))
    .orderBy(desc(chatMessages.pinnedAt)).limit(MAX_PINS);
  return { pins: await present(deps, rows) };
}

export async function markRead(deps: Deps, a: SuiteActor, channelId: string, messageId?: string) {
  if (isKey(a) || !a.userId) return { ok: true };
  const c = await visibleChannel(deps, a, channelId);
  let at = deps.now();
  if (messageId) { const m = await messageRow(deps, a.orgId, messageId); if (m.channelId === c.id) at = m.createdAt; }
  if (c.kind === "channel" && !c.isPrivate) await deps.db.insert(chatMembers).values({ channelId: c.id, userId: a.userId, orgId: a.orgId, lastReadAt: at, joinedAt: deps.now() }).onConflictDoUpdate({ target: [chatMembers.channelId, chatMembers.userId], set: { lastReadAt: at } });
  else await deps.db.update(chatMembers).set({ lastReadAt: at }).where(and(eq(chatMembers.channelId, c.id), eq(chatMembers.userId, a.userId)));
  return { ok: true };
}

export async function unreadSummary(deps: Deps, a: SuiteActor) {
  if (isKey(a) || !a.userId) return { total: 0, mentions: 0, channels: {} as Record<string, { unread: number; mentions: number }> };
  const map = await unreadFor(deps, a.orgId, a.userId);
  let total = 0, mentions = 0;
  const channels: Record<string, { unread: number; mentions: number }> = {};
  for (const [id, v] of map) { channels[id] = v; total += v.unread; mentions += v.mentions; }
  return { total, mentions, channels };
}

/** Turns a chat message into a task. The task links back to the message and the message shows the task. */
export async function messageToTask(deps: Deps, a: SuiteActor, id: string, input: { title?: string; projectId?: string; assignee?: { type: "member" | "agent"; id: string } | null; due?: string | null }) {
  assertWritable(a);
  const m = await messageRow(deps, a.orgId, id);
  const c = await visibleChannel(deps, a, m.channelId);
  if (m.deletedAt) throw notFound("Message");
  const mentions = JSON.parse(m.mentions) as Mention[];
  const links = JSON.parse(m.links) as ChatLink[];
  const text = plainText(m.body, mentions, links);
  const title = (input.title?.trim() || text.split("\n")[0] || "Follow up on a chat message").slice(0, 200);
  const where = c.kind === "dm" ? "a direct message" : `#${c.name}`;
  const task = await createTask(deps, a, {
    title, projectId: input.projectId, assignee: input.assignee, due: input.due ?? undefined,
    notes: `${text}\n\nFrom ${m.authorName} in ${where}.`,
  });
  await link(deps, a.orgId, { type: "task", id: task.id }, { type: "chat_message", id: m.id }, "from_chat");
  const next = [...links.filter((l) => !(l.type === "task" && l.id === task.id)), { type: "task" as const, id: task.id, ref: task.ref, title: task.title }];
  await deps.db.update(chatMessages).set({ links: JSON.stringify(next), updatedAt: deps.now() }).where(eq(chatMessages.id, m.id));
  return task;
}

export async function readChatFile(deps: Deps, a: SuiteActor | null, fileId: string, guest?: GuestViewer) {
  const orgId = guest?.orgId ?? a!.orgId;
  const f = await deps.db.select().from(chatFiles).where(and(eq(chatFiles.orgId, orgId), eq(chatFiles.id, fileId))).get();
  if (!f) throw notFound("File");
  if (guest) await guestChannel(deps, guest, f.channelId); else await visibleChannel(deps, a!, f.channelId);
  let bytes: Uint8Array | null = null;
  if (f.contentB64) { const { fromB64 } = await import("../../lib/crypto"); bytes = fromB64(f.contentB64); }
  else if (f.storageKey && deps.bodyStore) bytes = await deps.bodyStore.get(f.storageKey);
  if (!bytes) throw notFound("File");
  return { filename: f.filename, contentType: f.contentType, bytes };
}

export async function chatPeople(deps: Deps, orgId: string) {
  return assignees(deps, orgId);
}

// ---------------------------------------------------------------- guests

export async function guestChannel(deps: Deps, g: GuestViewer, id: string) {
  const c = await deps.db.select().from(chatChannels).where(and(eq(chatChannels.orgId, g.orgId), eq(chatChannels.id, id), isNull(chatChannels.deletedAt))).get();
  if (!c || c.kind !== "channel" || c.isPrivate || !c.guestAccess || c.projectId !== g.projectId) throw notFound();
  return c;
}

export async function guestChannels(deps: Deps, g: GuestViewer) {
  const rows = await deps.db.select().from(chatChannels).where(and(eq(chatChannels.orgId, g.orgId), eq(chatChannels.projectId, g.projectId), eq(chatChannels.guestAccess, true),
    eq(chatChannels.isPrivate, false), eq(chatChannels.kind, "channel"), eq(chatChannels.archived, false), isNull(chatChannels.deletedAt))).orderBy(asc(chatChannels.name));
  // Guests see channel names, never the member list.
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, topic: r.topic, lastMessageAt: iso(r.lastMessageAt) }));
}

export async function guestMessages(deps: Deps, g: GuestViewer, channelId: string, q: { limit?: number; before?: string; since?: string }) {
  const c = await guestChannel(deps, g, channelId);
  return listMessages(deps, c.id, q);
}

export async function guestThread(deps: Deps, g: GuestViewer, id: string) {
  const m = await messageRow(deps, g.orgId, id);
  await guestChannel(deps, g, m.channelId);
  return threadOf(deps, g.orgId, m);
}

export async function guestPost(deps: Deps, g: GuestViewer, channelId: string, input: { body: string; parentId?: string | null; files?: Upload[] }) {
  const c = await guestChannel(deps, g, channelId);
  const guestRow = await deps.db.select({ status: projectGuests.status }).from(projectGuests).where(eq(projectGuests.id, g.guestId)).get();
  if (!guestRow || guestRow.status !== "active") throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
  // Guests can't link into tasks or mail they can't see, or ping the whole channel.
  const body = (input.body ?? "").replace(LINK_RE, "").replace(/<!(channel|here)>/g, "@channel");
  const actor: SuiteActor = { orgId: g.orgId, userId: "", email: "", name: g.name, system: false };
  return writeMessage(deps, actor, c, { type: "guest", id: g.guestId, name: `${g.name} (guest)` }, { ...input, body });
}

/** Round 21: one message as the app shows it, or null when it is gone (a call's join card). */
export async function presentedMessage(deps: Deps, orgId: string, id: string) {
  const m = await deps.db.select().from(chatMessages).where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.id, id))).get();
  if (!m || m.deletedAt) return null;
  return (await present(deps, [m]))[0] ?? null;
}
