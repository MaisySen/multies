/**
 * R114: webinar mode for meetings (flag WEBINAR_R114). Built on the meeting stack: the same LiveKit room, the R32 lobby
 * rules for the guest link, the R34 call minutes, the R23 recordings (text only) and the R96 polls and Q&A tables.
 *
 * Roles: the member who created the meeting and the workspace owner and admins are hosts (settings, moderation,
 * registrations, report). Panelists (members or registrants the host promotes) publish. Everyone else in the room,
 * attendees and guests, watches only. Attendees never see another attendee's email.
 *
 * The cap is real: our video provider's free plan connects at most ROOM_PEOPLE_LIMIT people at once, and on the free
 * plan each person uses call minutes (R34), so a free workspace holds as many attendees as its minutes left allow.
 *
 * Reads on the attendee page are bounded: the shared parts (questions, polls, chat) are cached per meeting for
 * SHARED_CACHE_MS per isolate and the personal link lookup for TOKEN_CACHE_MS. No background job reads anything.
 */
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import {
  chatPollItems, chatPollVotes, chatPolls, meetingRecordings, meetings, members as orgMembers, organizations, users, webinarChat, webinarRegistrations, webinars,
} from "../../db/schema";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "./common";
import { cloudWords, isOpenPoll } from "../../../shared/chat-plus";
import { featureOn } from "../console/flags";

export const ROOM_PEOPLE_LIMIT = 100;
export const SHARED_CACHE_MS = 3_000;
export const TOKEN_CACHE_MS = 10_000;
export const JOIN_EARLY_MS = 15 * 60_000;
export const ENDED_AFTER_MS = 30 * 60_000;
export const REG_IP_LIMIT = 5;
export const REG_IP_WINDOW_MS = 10 * 60_000;
export const MIN_FORM_MS = 2_000;
export const QUESTION_GAP_MS = 10_000;
export const CHAT_GAP_MS = 3_000;
export const CHAT_MAX = 500;
export const QUESTION_MAX = 500;
export const CHAT_SHOWN = 50;
export const MAX_PANELISTS = 8;

export type ChatMode = "everyone" | "hosts" | "off";
export type Panelist = { kind: "member" | "registrant"; id: string; name: string };
export type WebinarPhase = "upcoming" | "open" | "ended" | "cancelled";

const invalid = (msg: string) => new HttpError(422, "validation_failed", msg);
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function webinarOn(deps: Deps) { return featureOn(deps, "webinar"); } // OPS1 feature flags: the platform wide value (a global switch)
function gate(deps: Deps) { if (!webinarOn(deps)) throw notFound("Page"); }

// ------------------------------------------------------------------ pure helpers

/**
 * How many attendees fit. `minutesCap` null means no monthly minutes cap (paid plans). Stage people (host and
 * panelists) count against the room limit and use minutes too.
 */
export function webinarCap(i: { minutesCap: number | null; minutesUsed: number; durationMin: number; stage: number }) {
  const stage = Math.max(1, i.stage);
  const room = Math.max(0, ROOM_PEOPLE_LIMIT - stage);
  if (i.minutesCap === null) return { cap: room, by: "room" as const, minutesLeft: null as number | null };
  const left = Math.max(0, i.minutesCap - i.minutesUsed);
  const len = Math.max(1, i.durationMin);
  const byMinutes = Math.max(0, Math.floor((left - stage * len) / len));
  return byMinutes < room ? { cap: byMinutes, by: "minutes" as const, minutesLeft: left } : { cap: room, by: "room" as const, minutesLeft: left };
}

export function capText(c: { cap: number; by: "room" | "minutes"; minutesLeft: number | null }, durationMin: number) {
  const head = `Up to ${c.cap} attendees on your plan.`;
  if (c.by === "room") return `${head} Video rooms hold ${ROOM_PEOPLE_LIMIT} people at once, hosts and panelists included.`;
  return `${head} Each attendee uses call minutes, and your plan has ${c.minutesLeft} left this month, enough for ${c.cap} people for ${durationMin} minutes.`;
}

export function phaseOf(m: { status: string; startsAt: Date; durationMin: number }, now: Date): WebinarPhase {
  if (m.status === "cancelled") return "cancelled";
  if (m.status === "ended") return "ended";
  const t = now.getTime();
  if (t > m.startsAt.getTime() + m.durationMin * 60_000 + ENDED_AFTER_MS) return "ended";
  if (t < m.startsAt.getTime() - JOIN_EARLY_MS) return "upcoming";
  return "open";
}

export const emailKey = (e: string) => e.trim().toLowerCase();
export function cleanName(raw: unknown): string { return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 80); }
export function cleanText(raw: unknown, max: number): string { return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max); }

/** A spreadsheet cell: quoted, and a leading = + - @ is made plain text so a spreadsheet never runs it. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");

/** In memory per isolate: registrations per IP, question and chat pacing. */
const regHits = new Map<string, number[]>();
const lastPost = new Map<string, number>();
export function clearWebinarLimits() { regHits.clear(); lastPost.clear(); sharedCache.clear(); tokenCache.clear(); }
export function registrationAllowed(ip: string, now: number) {
  const key = ip || "unknown";
  const hits = (regHits.get(key) ?? []).filter((t) => now - t < REG_IP_WINDOW_MS);
  if (hits.length >= REG_IP_LIMIT) { regHits.set(key, hits); return false; }
  hits.push(now); regHits.set(key, hits);
  return true;
}
function paced(key: string, gap: number, now: number, msg: string) {
  const last = lastPost.get(key);
  if (last !== undefined && now - last < gap) throw new HttpError(429, "slow_down", msg);
  lastPost.set(key, now);
}

// ------------------------------------------------------------------ rows

type WebinarRow = typeof webinars.$inferSelect;
type MeetingRow = typeof meetings.$inferSelect;
type RegRow = typeof webinarRegistrations.$inferSelect;
const panelistsOf = (w: WebinarRow): Panelist[] => { try { return JSON.parse(w.panelists) as Panelist[]; } catch { return []; } };

async function meetingFor(deps: Deps, a: SuiteActor, meetingId: string) {
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.orgId, a.orgId), eq(meetings.id, meetingId), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Meeting");
  return m;
}
async function webinarRow(deps: Deps, meetingId: string) {
  return deps.db.select().from(webinars).where(eq(webinars.meetingId, meetingId)).get();
}
export function canManage(a: SuiteActor, m: Pick<MeetingRow, "createdByType" | "createdById">) {
  if (a.system) return false;
  if (isAdmin(a) && !a.agentId) return true;
  if (a.agentId) return m.createdByType === "agent" && m.createdById === a.agentId;
  return m.createdByType === "member" && !!a.userId && m.createdById === a.userId;
}
function assertManage(a: SuiteActor, m: MeetingRow) {
  if (!canManage(a, m)) throw new HttpError(403, "forbidden", "Only the host of this webinar or a workspace admin can do this.");
}
const isMemberPanelist = (w: WebinarRow, a: SuiteActor) => !!a.userId && panelistsOf(w).some((p) => p.kind === "member" && p.id === a.userId);

/** Used when someone joins the room: who may speak. Null when the meeting is not a webinar. */
export async function stageRole(deps: Deps, a: SuiteActor | null, m: MeetingRow): Promise<{ host: boolean; publish: boolean } | null> {
  if (!webinarOn(deps)) return null;
  const w = await webinarRow(deps, m.id);
  if (!w || !w.enabled) return null;
  if (!a) return { host: false, publish: false };
  if (canManage(a, m)) return { host: true, publish: true };
  if (isMemberPanelist(w, a)) return { host: false, publish: true };
  return { host: false, publish: false };
}

async function capFor(deps: Deps, m: MeetingRow, w: WebinarRow | undefined) {
  const { meetingMinutes } = await import("./meeting-minutes-r34");
  const mm = await meetingMinutes(deps, m.orgId);
  const c = webinarCap({ minutesCap: mm.cap, minutesUsed: mm.used, durationMin: m.durationMin, stage: 1 + (w ? panelistsOf(w).length : 0) });
  return { ...c, text: capText(c, m.durationMin) };
}
async function registeredCount(deps: Deps, meetingId: string) {
  return (await deps.db.select({ n: count() }).from(webinarRegistrations).where(and(eq(webinarRegistrations.meetingId, meetingId), eq(webinarRegistrations.status, "registered"))).get())?.n ?? 0;
}
const regUrl = (deps: Deps, slug: string) => `${deps.config.appUrl}/w/${slug}`;
const joinUrl = (deps: Deps, token: string) => `${deps.config.appUrl}/w/a/${token}`;

// ------------------------------------------------------------------ host side

function presentSettings(deps: Deps, m: MeetingRow, w: WebinarRow | undefined, manage: boolean) {
  return {
    meetingId: m.id, enabled: !!w?.enabled, canManage: manage,
    registrationOpen: w ? w.registrationOpen : true, chatMode: (w?.chatMode ?? "everyone") as ChatMode, description: w?.description ?? "",
    registrationUrl: w ? regUrl(deps, w.slug) : null, panelists: w ? panelistsOf(w) : [],
    replay: { recordingId: w?.replayRecordingId ?? null, shared: !!w?.replayShared },
    phase: phaseOf(m, deps.now()),
  };
}

export async function getWebinar(deps: Deps, a: SuiteActor, meetingId: string) {
  gate(deps);
  const m = await meetingFor(deps, a, meetingId);
  const w = await webinarRow(deps, m.id);
  const manage = canManage(a, m);
  const cap = await capFor(deps, m, w);
  return { webinar: { ...presentSettings(deps, m, w, manage), cap, registered: manage && w ? await registeredCount(deps, m.id) : null } };
}

export async function updateWebinar(deps: Deps, a: SuiteActor, meetingId: string, patch: { enabled?: boolean; registrationOpen?: boolean; chatMode?: ChatMode; description?: string }) {
  gate(deps); assertWritable(a);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const w = await webinarRow(deps, m.id);
  const now = deps.now();
  if (!w) {
    if (patch.enabled === false) return getWebinar(deps, a, meetingId);
    if (m.status === "cancelled") throw new HttpError(409, "meeting_cancelled", "This meeting was cancelled.");
    const qa = await ensureQa(deps, a, m);
    await deps.db.insert(webinars).values({
      meetingId: m.id, orgId: m.orgId, enabled: true, registrationOpen: patch.registrationOpen ?? true, slug: randomToken(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 14),
      chatMode: patch.chatMode ?? "everyone", qaPollId: qa, panelists: "[]", description: cleanText(patch.description ?? "", 1000), createdBy: a.userId ?? a.agentId ?? null, createdAt: now, updatedAt: now,
    });
    // R32 guests from the meeting link keep waiting to be let in; a webinar starts with the waiting room on.
    if (!m.guestLobby) await deps.db.update(meetings).set({ guestLobby: true }).where(eq(meetings.id, m.id));
  } else {
    const set: Partial<WebinarRow> = { updatedAt: now };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.registrationOpen !== undefined) set.registrationOpen = patch.registrationOpen;
    if (patch.chatMode !== undefined) set.chatMode = patch.chatMode;
    if (patch.description !== undefined) set.description = cleanText(patch.description, 1000);
    if (patch.enabled && !w.qaPollId) set.qaPollId = await ensureQa(deps, a, m);
    await deps.db.update(webinars).set(set).where(eq(webinars.meetingId, m.id));
  }
  sharedCache.delete(m.id); tokenCache.clear();
  return getWebinar(deps, a, meetingId);
}

async function ensureQa(deps: Deps, a: SuiteActor, m: MeetingRow) {
  const { createPoll } = await import("./chat-plus");
  const actor = a.userId ? a : { ...a, userId: m.createdById ?? undefined };
  try {
    const r = await createPoll(deps, actor as SuiteActor, { kind: "qa", question: `Questions for ${m.title}`.slice(0, 200), meetingId: m.id });
    return r.poll.id;
  } catch { return null; }
}

export async function setPanelist(deps: Deps, a: SuiteActor, meetingId: string, input: { kind: "member" | "registrant"; id: string; on: boolean }) {
  gate(deps); assertWritable(a);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const w = await webinarRow(deps, m.id);
  if (!w || !w.enabled) throw new HttpError(409, "not_webinar", "Turn on webinar mode first.");
  let list = panelistsOf(w).filter((p) => !(p.kind === input.kind && p.id === input.id));
  if (input.on) {
    let name: string;
    if (input.kind === "member") {
      const row = await deps.db.select({ name: users.name, email: users.email }).from(orgMembers).innerJoin(users, eq(users.id, orgMembers.userId))
        .where(and(eq(orgMembers.organizationId, m.orgId), eq(orgMembers.userId, input.id))).get();
      if (!row) throw notFound("Member");
      name = row.name || row.email;
    } else {
      const r = await deps.db.select().from(webinarRegistrations).where(and(eq(webinarRegistrations.meetingId, m.id), eq(webinarRegistrations.id, input.id), eq(webinarRegistrations.status, "registered"))).get();
      if (!r) throw notFound("Registration");
      name = r.name;
    }
    if (list.length >= MAX_PANELISTS) throw invalid(`A webinar holds up to ${MAX_PANELISTS} panelists besides the hosts.`);
    list = [...list, { kind: input.kind, id: input.id, name }];
  }
  await deps.db.update(webinars).set({ panelists: JSON.stringify(list), updatedAt: deps.now() }).where(eq(webinars.meetingId, m.id));
  tokenCache.clear(); sharedCache.delete(m.id);
  await updateRoomPermission(deps, m.room, input.kind === "member" ? `member-${input.id}` : `reg-${input.id}`, input.on);
  return getWebinar(deps, a, meetingId);
}

/** Best effort: change a person's rights in a live room at once. Their next token carries the same rights anyway. */
async function updateRoomPermission(deps: Deps, room: string, identity: string, publish: boolean) {
  const cfg = deps.config.meetings;
  if (!cfg || deps.callRooms) return;
  try {
    const { RoomServiceClient } = await import("livekit-server-sdk");
    const host = cfg.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    const svc = new RoomServiceClient(host, cfg.apiKey, cfg.apiSecret);
    await Promise.race([
      svc.updateParticipant(room, identity, undefined, { canPublish: publish, canSubscribe: true, canPublishData: publish }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
    ]);
  } catch { /* not in the room right now */ }
}

type ItemRow = typeof chatPollItems.$inferSelect;
async function qaItems(deps: Deps, w: WebinarRow) {
  if (!w.qaPollId) return { items: [] as ItemRow[], votes: [] as (typeof chatPollVotes.$inferSelect)[] };
  const items = await deps.db.select().from(chatPollItems).where(eq(chatPollItems.pollId, w.qaPollId)).limit(200);
  const votes = await deps.db.select().from(chatPollVotes).where(eq(chatPollVotes.pollId, w.qaPollId)).limit(5000);
  return { items, votes };
}

/** The host's live view: every question and chat message, hidden ones marked. */
export async function liveView(deps: Deps, a: SuiteActor, meetingId: string) {
  gate(deps);
  const m = await meetingFor(deps, a, meetingId);
  const w = await webinarRow(deps, m.id);
  if (!w || !w.enabled) throw new HttpError(409, "not_webinar", "Turn on webinar mode first.");
  const manage = canManage(a, m);
  if (!manage && !isMemberPanelist(w, a)) throw new HttpError(403, "forbidden", "Only hosts and panelists see the live questions.");
  const { items, votes } = await qaItems(deps, w);
  const up = new Map<string, number>();
  for (const v of votes) up.set(v.choice, (up.get(v.choice) ?? 0) + 1);
  const questions = items.map((it) => ({ id: it.id, body: it.body, authorName: it.authorName, votes: up.get(it.id) ?? 0, answered: !!it.answeredAt, hidden: !!it.hiddenAt, answer: it.answer ?? null, createdAt: it.createdAt.toISOString() }))
    .sort((x, y) => Number(x.hidden) - Number(y.hidden) || Number(x.answered) - Number(y.answered) || y.votes - x.votes || x.createdAt.localeCompare(y.createdAt));
  const chat = await deps.db.select().from(webinarChat).where(eq(webinarChat.meetingId, m.id)).orderBy(desc(webinarChat.id)).limit(100);
  const regs = manage ? await deps.db.select({ id: webinarRegistrations.id, name: webinarRegistrations.name, joinedAt: webinarRegistrations.joinedAt, lastSeenAt: webinarRegistrations.lastSeenAt })
    .from(webinarRegistrations).where(and(eq(webinarRegistrations.meetingId, m.id), eq(webinarRegistrations.status, "registered"))).limit(ROOM_PEOPLE_LIMIT) : [];
  const now = deps.now().getTime();
  const { listPolls } = await import("./webinar-r114-polls");
  return {
    canManage: manage, chatMode: w.chatMode, panelists: panelistsOf(w), qaPollId: w.qaPollId,
    questions,
    chat: chat.reverse().map((c) => ({ id: c.id, authorName: c.authorName, authorKind: c.authorKind, body: c.body, hidden: !!c.hiddenAt, createdAt: c.createdAt.toISOString() })),
    attendees: regs.map((r) => ({ id: r.id, name: r.name, joined: !!r.joinedAt, watchingNow: !!r.lastSeenAt && now - r.lastSeenAt.getTime() < 3 * 60_000 })),
    polls: await listPolls(deps, m, null, true),
  };
}

export async function moderateQuestion(deps: Deps, a: SuiteActor, meetingId: string, itemId: string, input: { hidden?: boolean; answer?: string | null; answered?: boolean }) {
  gate(deps); assertWritable(a);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const w = await webinarRow(deps, m.id);
  if (!w?.qaPollId) throw notFound("Question");
  const it = await deps.db.select().from(chatPollItems).where(and(eq(chatPollItems.id, itemId), eq(chatPollItems.pollId, w.qaPollId))).get();
  if (!it) throw notFound("Question");
  const set: Partial<ItemRow> = {};
  const now = deps.now();
  if (input.hidden !== undefined) set.hiddenAt = input.hidden ? now : null;
  if (input.answer !== undefined) {
    const ans = input.answer === null ? null : cleanText(input.answer, 1000) || null;
    set.answer = ans;
    if (ans) set.answeredAt = it.answeredAt ?? now;
  }
  if (input.answered !== undefined) set.answeredAt = input.answered ? it.answeredAt ?? now : null;
  if (Object.keys(set).length) await deps.db.update(chatPollItems).set(set).where(eq(chatPollItems.id, it.id));
  sharedCache.delete(m.id);
  return { ok: true };
}

export async function hostChat(deps: Deps, a: SuiteActor, meetingId: string, body: string) {
  gate(deps); assertWritable(a);
  const m = await meetingFor(deps, a, meetingId);
  const w = await webinarRow(deps, m.id);
  if (!w || !w.enabled) throw new HttpError(409, "not_webinar", "Turn on webinar mode first.");
  if (!canManage(a, m) && !isMemberPanelist(w, a)) throw new HttpError(403, "forbidden", "Only hosts and panelists chat from here.");
  if (w.chatMode === "off") throw new HttpError(409, "chat_off", "Chat is off. Turn it on in the chat setting first.");
  const text = cleanText(body, CHAT_MAX);
  if (!text) throw invalid("Write a message first.");
  const now = deps.now();
  await deps.db.insert(webinarChat).values({ id: sortableId("wch", now.getTime()), orgId: m.orgId, meetingId: m.id, authorKind: "member", authorId: a.userId ?? null, authorName: (a.name || a.email || "Host").slice(0, 80), body: text, createdAt: now });
  sharedCache.delete(m.id);
  return { ok: true };
}

export async function hideChat(deps: Deps, a: SuiteActor, meetingId: string, messageId: string, hidden: boolean) {
  gate(deps); assertWritable(a);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const row = await deps.db.select({ id: webinarChat.id }).from(webinarChat).where(and(eq(webinarChat.meetingId, m.id), eq(webinarChat.id, messageId))).get();
  if (!row) throw notFound("Message");
  await deps.db.update(webinarChat).set({ hiddenAt: hidden ? deps.now() : null }).where(eq(webinarChat.id, row.id));
  sharedCache.delete(m.id);
  return { ok: true };
}

export async function hostPoll(deps: Deps, a: SuiteActor, meetingId: string, input: { question: string; options: string[]; multi?: boolean }) {
  gate(deps);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const { createPoll } = await import("./chat-plus");
  const r = await createPoll(deps, a, { kind: "poll", question: input.question, options: input.options, multi: !!input.multi, meetingId: m.id });
  sharedCache.delete(m.id);
  return r;
}

export async function hostClosePoll(deps: Deps, a: SuiteActor, meetingId: string, pollId: string) {
  gate(deps);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const p = await deps.db.select({ id: chatPolls.id }).from(chatPolls).where(and(eq(chatPolls.orgId, m.orgId), eq(chatPolls.id, pollId), eq(chatPolls.meetingId, m.id))).get();
  if (!p) throw notFound("Poll");
  const { closePoll } = await import("./chat-plus");
  const r = await closePoll(deps, a, p.id);
  sharedCache.delete(m.id);
  return r;
}

export async function setReplay(deps: Deps, a: SuiteActor, meetingId: string, input: { recordingId: string | null; shared: boolean }) {
  gate(deps); assertWritable(a);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const w = await webinarRow(deps, m.id);
  if (!w) throw new HttpError(409, "not_webinar", "Turn on webinar mode first.");
  if (input.recordingId) {
    const r = await deps.db.select({ status: meetingRecordings.status }).from(meetingRecordings)
      .where(and(eq(meetingRecordings.orgId, m.orgId), eq(meetingRecordings.meetingId, m.id), eq(meetingRecordings.id, input.recordingId))).get();
    if (!r) throw notFound("Recording");
    if (r.status !== "done") throw new HttpError(409, "recording_not_ready", "That recording is still being written up. Try again when it shows as done.");
  }
  if (input.shared && !input.recordingId) throw invalid("Pick a recording to share first.");
  await deps.db.update(webinars).set({ replayRecordingId: input.recordingId, replayShared: input.shared, updatedAt: deps.now() }).where(eq(webinars.meetingId, m.id));
  sharedCache.delete(m.id); tokenCache.clear();
  return getWebinar(deps, a, meetingId);
}

// ------------------------------------------------------------------ report

export async function webinarReport(deps: Deps, a: SuiteActor, meetingId: string) {
  gate(deps);
  const m = await meetingFor(deps, a, meetingId);
  assertManage(a, m);
  const w = await webinarRow(deps, m.id);
  if (!w) throw new HttpError(409, "not_webinar", "Turn on webinar mode first.");
  const regs = await deps.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.meetingId, m.id)).limit(2000);
  const { items } = await qaItems(deps, w);
  const asked = new Map<string, number>();
  for (const it of items) if (it.authorId) asked.set(it.authorId, (asked.get(it.authorId) ?? 0) + 1);
  const people = regs.filter((r) => r.status === "registered").sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((r) => ({
    id: r.id, name: r.name, email: r.email, registeredAt: r.createdAt.toISOString(), attended: !!r.joinedAt, joinedAt: r.joinedAt?.toISOString() ?? null,
    minutesWatched: r.minutesWatched, questions: asked.get(`reg:${r.id}`) ?? 0,
  }));
  const attended = people.filter((p) => p.attended);
  const { listPolls } = await import("./webinar-r114-polls");
  const polls = await listPolls(deps, m, null, true);
  return {
    title: m.title, startsAt: m.startsAt.toISOString(),
    totals: {
      registered: people.length, attended: attended.length,
      averageMinutes: attended.length ? Math.round(attended.reduce((n, p) => n + p.minutesWatched, 0) / attended.length) : 0,
      questions: items.length, answered: items.filter((i) => i.answeredAt).length,
    },
    people,
    polls: polls.map((p) => ({ id: p.id, question: p.question, kind: p.kind, closed: !p.open, results: p.results })),
  };
}

export async function webinarReportCsv(deps: Deps, a: SuiteActor, meetingId: string) {
  const r = await webinarReport(deps, a, meetingId);
  const lines = [csvLine(["Name", "Email", "Registered at", "Attended", "First joined", "Minutes watched", "Questions asked"])];
  for (const p of r.people) lines.push(csvLine([p.name, p.email, p.registeredAt, p.attended ? "Yes" : "No", p.joinedAt ?? "", p.minutesWatched, p.questions]));
  if (r.polls.length) {
    lines.push("", csvLine(["Poll", "Choice", "Votes"]));
    for (const p of r.polls) for (const x of p.results) lines.push(csvLine([p.question, x.label, x.count]));
  }
  const name = `${r.title.replace(/[^A-Za-z0-9 ]+/g, "").trim().replace(/\s+/g, " ").slice(0, 60) || "Webinar"} attendees.csv`;
  return { filename: name, csv: lines.join("\r\n") + "\r\n" };
}

// ------------------------------------------------------------------ public: registration

async function publicRow(deps: Deps, slug: string) {
  gate(deps);
  const w = await deps.db.select().from(webinars).where(eq(webinars.slug, slug)).get();
  if (!w || !w.enabled) throw notFound("Webinar");
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.id, w.meetingId), isNull(meetings.deletedAt))).get();
  if (!m) throw notFound("Webinar");
  return { w, m };
}

export async function publicInfo(deps: Deps, slug: string) {
  const { w, m } = await publicRow(deps, slug);
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, m.orgId)).get();
  const cap = await capFor(deps, m, w);
  const n = await registeredCount(deps, m.id);
  return {
    title: m.title, description: w.description, host: org?.name ?? "", startsAt: m.startsAt.toISOString(), durationMin: m.durationMin,
    phase: phaseOf(m, deps.now()), registrationOpen: w.registrationOpen, full: n >= cap.cap, capText: `Up to ${cap.cap} attendees.`,
    panelists: panelistsOf(w).map((p) => p.name),
  };
}

export async function register(deps: Deps, slug: string, input: { name?: string; email?: string; website?: string; openedAt?: number }, ip: string) {
  const { w, m } = await publicRow(deps, slug);
  const now = deps.now();
  // Bot check, no outside service: a hidden field people never fill, and a form that took at least two seconds.
  if (input.website) throw new HttpError(422, "bot_check", "We couldn't take that registration. Please try again.");
  if (!input.openedAt || now.getTime() - input.openedAt < MIN_FORM_MS) throw new HttpError(422, "bot_check", "That was quick. Please check your details and send again.");
  const phase = phaseOf(m, now);
  if (phase === "cancelled") throw new HttpError(409, "webinar_cancelled", "This webinar was cancelled.");
  if (phase === "ended") throw new HttpError(409, "webinar_ended", "This webinar has ended.");
  if (!w.registrationOpen) throw new HttpError(409, "registration_closed", "Registration is closed for this webinar.");
  const name = cleanName(input.name);
  if (!name) throw invalid("Add your name.");
  const email = String(input.email ?? "").trim().slice(0, 254);
  if (!EMAIL_RE.test(email)) throw invalid("Add an email address we can send your link to.");
  if (!registrationAllowed(ip, now.getTime())) throw new HttpError(429, "too_many", "Too many registrations from here. Try again in a few minutes.");
  const key = emailKey(email);
  const existing = await deps.db.select().from(webinarRegistrations).where(and(eq(webinarRegistrations.meetingId, m.id), eq(webinarRegistrations.emailKey, key))).get();
  if (existing && existing.status === "registered") {
    // Never show the link on screen for an address someone may not own: a fresh link goes to that inbox only.
    const token = randomToken(24);
    await deps.db.update(webinarRegistrations).set({ tokenHash: await sha256Hex(token) }).where(eq(webinarRegistrations.id, existing.id));
    tokenCache.clear();
    await mailLink(deps, m, existing.email, existing.name, token, true);
    return { status: "already" as const, message: "You're already registered. We sent your join link to that email again." };
  }
  const cap = await capFor(deps, m, w);
  if ((await registeredCount(deps, m.id)) >= cap.cap) throw new HttpError(409, "webinar_full", "This webinar is full.");
  const token = randomToken(24);
  const tokenHash = await sha256Hex(token);
  if (existing) {
    await deps.db.update(webinarRegistrations).set({ status: "registered", name, email, tokenHash, createdAt: now }).where(eq(webinarRegistrations.id, existing.id));
  } else {
    await deps.db.insert(webinarRegistrations).values({ id: sortableId("wrg", now.getTime()), orgId: m.orgId, meetingId: m.id, name, email, emailKey: key, tokenHash, createdAt: now })
      .onConflictDoNothing();
  }
  const mailed = await mailLink(deps, m, email, name, token, false);
  return { status: "registered" as const, joinUrl: joinUrl(deps, token), mailed };
}

/** "Sun 1 Nov 2026, 4:55 pm AEDT": the start in the workspace's time zone, as people read it in a mail. */
export function mailWhen(at: Date, timeZone: string) {
  try {
    const p = new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).formatToParts(at);
    const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return `${v("weekday")} ${v("day")} ${v("month")} ${v("year")}, ${v("hour")}:${v("minute")} ${v("dayPeriod").toLowerCase()} ${v("timeZoneName")}`;
  } catch {
    return at.toUTCString().replace(":00 GMT", " UTC");
  }
}

async function mailLink(deps: Deps, m: MeetingRow, to: string, name: string, token: string, again: boolean) {
  try {
    const { sendSystemEmail } = await import("../system-mail");
    const org = await deps.db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, m.orgId)).get();
    const when = mailWhen(m.startsAt, org?.timezone ?? "UTC");
    const r = await sendSystemEmail(deps, {
      to, orgId: m.orgId, subject: again ? `Your link for ${m.title}` : `You're registered for ${m.title}`,
      text: `Hi ${name},\n\n${again ? "Here is your join link again" : "You're registered"} for ${m.title} on ${when}.\n\nThis link is only for you, so please don't share it. Open it a few minutes before the start to watch, ask questions and vote in polls.`,
      action: { label: "Open your webinar page", url: joinUrl(deps, token) },
    });
    return r.delivered;
  } catch { return false; }
}

// ------------------------------------------------------------------ public: attendee

type Viewer = { reg: RegRow; w: WebinarRow; m: MeetingRow };
const tokenCache = new Map<string, { at: number; v: Viewer }>();
async function viewer(deps: Deps, token: string): Promise<Viewer> {
  gate(deps);
  if (!token || token.length > 80) throw notFound("Registration");
  const now = deps.now().getTime();
  const hit = tokenCache.get(token);
  if (hit && now - hit.at < TOKEN_CACHE_MS) return hit.v;
  const reg = await deps.db.select().from(webinarRegistrations).where(eq(webinarRegistrations.tokenHash, await sha256Hex(token))).get();
  if (!reg || reg.status !== "registered") throw notFound("Registration");
  const w = await webinarRow(deps, reg.meetingId);
  const m = await deps.db.select().from(meetings).where(and(eq(meetings.id, reg.meetingId), isNull(meetings.deletedAt))).get();
  if (!w || !w.enabled || !m) throw notFound("Webinar");
  const v = { reg, w, m };
  tokenCache.set(token, { at: now, v });
  if (tokenCache.size > 2000) tokenCache.clear();
  return v;
}
const regPanelist = (v: Viewer) => panelistsOf(v.w).some((p) => p.kind === "registrant" && p.id === v.reg.id);

type Shared = { questions: { id: string; body: string; authorName: string; authorId: string | null; votes: number; voters: Set<string>; answered: boolean; hidden: boolean; answer: string | null; createdAt: string }[]; chat: { id: string; authorName: string; host: boolean; body: string; createdAt: string }[]; polls: Awaited<ReturnType<typeof import("./webinar-r114-polls").listPolls>> };
const sharedCache = new Map<string, { at: number; v: Shared }>();
async function shared(deps: Deps, w: WebinarRow, m: MeetingRow): Promise<Shared> {
  const now = deps.now().getTime();
  const hit = sharedCache.get(m.id);
  if (hit && now - hit.at < SHARED_CACHE_MS) return hit.v;
  const { items, votes } = await qaItems(deps, w);
  const voters = new Map<string, Set<string>>();
  for (const v of votes) { const s = voters.get(v.choice) ?? new Set<string>(); s.add(v.voter); voters.set(v.choice, s); }
  const questions = items.map((it) => ({ id: it.id, body: it.body, authorName: it.authorName, authorId: it.authorId, votes: voters.get(it.id)?.size ?? 0, voters: voters.get(it.id) ?? new Set<string>(), answered: !!it.answeredAt, hidden: !!it.hiddenAt, answer: it.answer ?? null, createdAt: it.createdAt.toISOString() }));
  const chatRows = w.chatMode === "off" ? [] : await deps.db.select().from(webinarChat).where(and(eq(webinarChat.meetingId, m.id), isNull(webinarChat.hiddenAt))).orderBy(desc(webinarChat.id)).limit(CHAT_SHOWN);
  const chat = chatRows.reverse().map((c) => ({ id: c.id, authorName: c.authorName, host: c.authorKind === "member", body: c.body, createdAt: c.createdAt.toISOString() }));
  const { listPolls } = await import("./webinar-r114-polls");
  const polls = await listPolls(deps, m, null, false);
  const v = { questions, chat, polls };
  sharedCache.set(m.id, { at: now, v });
  if (sharedCache.size > 500) sharedCache.clear();
  return v;
}

export async function attendeeState(deps: Deps, token: string) {
  const v = await viewer(deps, token);
  const { w, m, reg } = v;
  const me = `reg:${reg.id}`;
  const s = await shared(deps, w, m);
  const { myVotes } = await import("./webinar-r114-polls");
  const mine = await myVotes(deps, s.polls.map((p) => p.id), me);
  const org = await orgName(deps, m.orgId);
  return {
    title: m.title, description: w.description, host: org, startsAt: m.startsAt.toISOString(), durationMin: m.durationMin, phase: phaseOf(m, deps.now()),
    me: { name: reg.name, role: regPanelist(v) ? "panelist" : "attendee" }, chatMode: w.chatMode, videoEnabled: !!deps.config.meetings,
    questions: s.questions.filter((q) => !q.hidden || q.authorId === me).map((q) => ({
      id: q.id, body: q.body, authorName: q.authorName, votes: q.votes, upvoted: q.voters.has(me), mine: q.authorId === me, answered: q.answered, hidden: q.hidden, answer: q.answer, createdAt: q.createdAt,
    })).sort((x, y) => Number(x.answered) - Number(y.answered) || y.votes - x.votes || x.createdAt.localeCompare(y.createdAt)),
    canAsk: !!w.qaPollId,
    polls: s.polls.map((p) => ({ ...p, voted: (mine.get(p.id) ?? []).length > 0, myChoices: mine.get(p.id) ?? [], results: (mine.get(p.id) ?? []).length > 0 || !p.open ? p.results : null })),
    chat: s.chat,
    replay: !!w.replayShared && !!w.replayRecordingId,
  };
}
const orgNames = new Map<string, string>();
async function orgName(deps: Deps, orgId: string) {
  const hit = orgNames.get(orgId);
  if (hit !== undefined) return hit;
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  orgNames.set(orgId, org?.name ?? "");
  return org?.name ?? "";
}

export async function attendeeJoin(deps: Deps, token: string) {
  const v = await viewer(deps, token);
  const phase = phaseOf(v.m, deps.now());
  if (phase === "upcoming") throw new HttpError(409, "not_started", "The webinar has not started yet. Come back a few minutes before the start.");
  if (phase === "ended") throw new HttpError(409, "webinar_ended", "This webinar has ended.");
  if (phase === "cancelled") throw new HttpError(409, "webinar_cancelled", "This webinar was cancelled.");
  const { livekitToken, minutesLeftForRoomPublic } = await import("./meetings");
  await minutesLeftForRoomPublic(deps, v.m);
  const now = deps.now();
  if (!v.reg.joinedAt) {
    await deps.db.update(webinarRegistrations).set({ joinedAt: now, lastSeenAt: now }).where(eq(webinarRegistrations.id, v.reg.id));
    v.reg.joinedAt = now; v.reg.lastSeenAt = now;
  }
  const publish = regPanelist(v);
  return { role: publish ? "panelist" : "attendee", ...(await livekitToken(deps, v.m.room, { identity: `reg-${v.reg.id}`, name: v.reg.name, host: false, publish })) };
}

/** Once a minute while the page is open and joined: one UPDATE, at most a minute per 50 seconds. */
export async function heartbeat(deps: Deps, token: string) {
  const v = await viewer(deps, token);
  const now = deps.now();
  if (phaseOf(v.m, now) !== "open") return { ok: true, counted: false };
  const row = await deps.db.select({ last: webinarRegistrations.lastSeenAt, min: webinarRegistrations.minutesWatched, joined: webinarRegistrations.joinedAt }).from(webinarRegistrations).where(eq(webinarRegistrations.id, v.reg.id)).get();
  if (!row?.joined) return { ok: true, counted: false };
  if (row.last && now.getTime() - row.last.getTime() < 50_000) return { ok: true, counted: false };
  const cap = v.m.durationMin + ENDED_AFTER_MS / 60_000;
  await deps.db.update(webinarRegistrations).set({ lastSeenAt: now, minutesWatched: Math.min(cap, row.min + 1) }).where(eq(webinarRegistrations.id, v.reg.id));
  return { ok: true, counted: true };
}

export async function attendeeAsk(deps: Deps, token: string, body: string) {
  const v = await viewer(deps, token);
  if (phaseOf(v.m, deps.now()) !== "open") throw new HttpError(409, "not_open", "Questions open a few minutes before the start.");
  if (!v.w.qaPollId) throw new HttpError(409, "qa_off", "Questions are not open for this webinar.");
  const text = cleanText(body, QUESTION_MAX);
  if (!text) throw invalid("Write your question first.");
  const now = deps.now();
  paced(`q:${v.reg.id}`, QUESTION_GAP_MS, now.getTime(), "One question every 10 seconds, please.");
  const p = await deps.db.select().from(chatPolls).where(eq(chatPolls.id, v.w.qaPollId)).get();
  if (!p || !isOpenPoll(p, now)) throw new HttpError(409, "qa_closed", "Questions are closed.");
  const n = (await deps.db.select({ n: count() }).from(chatPollItems).where(eq(chatPollItems.pollId, p.id)).get())?.n ?? 0;
  if (n >= 200) throw new HttpError(422, "too_many_questions", "This webinar has taken as many questions as it can.");
  await deps.db.insert(chatPollItems).values({ id: sortableId("cpq", now.getTime()), pollId: p.id, orgId: p.orgId, body: text, authorId: `reg:${v.reg.id}`, authorName: v.reg.name, createdAt: now });
  sharedCache.delete(v.m.id);
  return attendeeState(deps, token);
}

export async function attendeeUpvote(deps: Deps, token: string, itemId: string) {
  const v = await viewer(deps, token);
  if (!v.w.qaPollId) throw notFound("Question");
  const me = `reg:${v.reg.id}`;
  const it = await deps.db.select().from(chatPollItems).where(and(eq(chatPollItems.id, itemId), eq(chatPollItems.pollId, v.w.qaPollId))).get();
  if (!it || it.hiddenAt) throw notFound("Question");
  if (it.authorId === me) throw invalid("You can't upvote your own question.");
  if (it.answeredAt) throw new HttpError(409, "answered", "This question was answered.");
  const had = await deps.db.select({ v: chatPollVotes.voter }).from(chatPollVotes).where(and(eq(chatPollVotes.pollId, it.pollId), eq(chatPollVotes.voter, me), eq(chatPollVotes.choice, it.id))).get();
  if (had) await deps.db.delete(chatPollVotes).where(and(eq(chatPollVotes.pollId, it.pollId), eq(chatPollVotes.voter, me), eq(chatPollVotes.choice, it.id)));
  else await deps.db.insert(chatPollVotes).values({ pollId: it.pollId, voter: me, choice: it.id, orgId: it.orgId, voterName: v.reg.name, createdAt: deps.now() }).onConflictDoNothing();
  sharedCache.delete(v.m.id);
  return attendeeState(deps, token);
}

export async function attendeeVote(deps: Deps, token: string, pollId: string, choices: string[]) {
  const v = await viewer(deps, token);
  const p = await deps.db.select().from(chatPolls).where(and(eq(chatPolls.id, pollId), eq(chatPolls.meetingId, v.m.id))).get();
  if (!p || (p.kind !== "poll" && p.kind !== "cloud")) throw notFound("Poll");
  const now = deps.now();
  if (!isOpenPoll(p, now)) throw new HttpError(409, "poll_closed", "This poll has closed.");
  const options = JSON.parse(p.options) as string[];
  let picked: string[];
  if (p.kind === "poll") {
    picked = [...new Set(choices)];
    if (!picked.length) throw invalid("Pick a choice first.");
    if (picked.some((c) => !/^\d+$/.test(c) || Number(c) >= options.length)) throw invalid("Pick one of the poll's choices.");
    if (!p.multi && picked.length > 1) throw invalid("This poll takes one choice.");
  } else {
    picked = cloudWords(choices);
    if (!picked.length) throw invalid("Use letters or numbers.");
  }
  const me = `reg:${v.reg.id}`;
  await deps.db.delete(chatPollVotes).where(and(eq(chatPollVotes.pollId, p.id), eq(chatPollVotes.voter, me)));
  await deps.db.insert(chatPollVotes).values(picked.map((choice) => ({ pollId: p.id, voter: me, choice, orgId: p.orgId, voterName: v.reg.name, reason: "", createdAt: now })));
  await deps.db.update(chatPolls).set({ updatedAt: now }).where(eq(chatPolls.id, p.id));
  sharedCache.delete(v.m.id);
  return attendeeState(deps, token);
}

export async function attendeeChat(deps: Deps, token: string, body: string) {
  const v = await viewer(deps, token);
  if (v.w.chatMode === "off") throw new HttpError(409, "chat_off", "The host turned chat off.");
  if (v.w.chatMode === "hosts" && !regPanelist(v)) throw new HttpError(403, "chat_hosts_only", "Only hosts and panelists can chat right now.");
  if (phaseOf(v.m, deps.now()) !== "open") throw new HttpError(409, "not_open", "Chat opens a few minutes before the start.");
  const text = cleanText(body, CHAT_MAX);
  if (!text) throw invalid("Write a message first.");
  const now = deps.now();
  paced(`c:${v.reg.id}`, CHAT_GAP_MS, now.getTime(), "Slow down a little, one message every few seconds.");
  await deps.db.insert(webinarChat).values({ id: sortableId("wch", now.getTime()), orgId: v.m.orgId, meetingId: v.m.id, authorKind: "registrant", authorId: v.reg.id, authorName: v.reg.name, body: text, createdAt: now });
  sharedCache.delete(v.m.id);
  return attendeeState(deps, token);
}

export async function attendeeReplay(deps: Deps, token: string) {
  const v = await viewer(deps, token);
  if (!v.w.replayShared || !v.w.replayRecordingId) throw new HttpError(404, "no_replay", "The host has not shared a replay yet.");
  const r = await deps.db.select().from(meetingRecordings).where(and(eq(meetingRecordings.orgId, v.m.orgId), eq(meetingRecordings.meetingId, v.m.id), eq(meetingRecordings.id, v.w.replayRecordingId))).get();
  if (!r || r.status !== "done") throw new HttpError(404, "no_replay", "The host has not shared a replay yet.");
  const { parseSummary } = await import("./meeting-recordings");
  const s = parseSummary(r.summary);
  const sh = await shared(deps, v.w, v.m);
  return {
    title: v.m.title, host: await orgName(deps, v.m.orgId), startsAt: v.m.startsAt.toISOString(), durationSec: r.durationSec,
    summary: s?.summary ?? (r.summary && !s ? r.summary : null), decisions: s?.decisions ?? [], transcript: r.transcript,
    answered: sh.questions.filter((q) => q.answered && !q.hidden).map((q) => ({ id: q.id, body: q.body, authorName: q.authorName, answer: q.answer })),
    polls: sh.polls.filter((p) => !p.open).map((p) => ({ id: p.id, question: p.question, results: p.results })),
  };
}

