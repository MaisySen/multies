/**
 * R92: group time polls. A member proposes times and shares /book/poll/<token>; guests vote Yes, If need be or No
 * without an account (spam shield on the public form); the host picks the winner, which makes a meeting with its
 * video link and mails every voter who left an email. One poll reads three small tables, bounded.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { meetings, timePollOptions, timePollVotes, timePolls, users } from "../../db/schema";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, sortableId, type SuiteActor } from "../suite/common";
import { validTimezone } from "../suite/scheduling";
import { assertBookingPlus } from "./resources";
import { POLL_ANSWERS, POLL_MAX_OPTIONS, POLL_MAX_VOTES, bestOption, pollTotals, type PollAnswer } from "@/shared/booking-plus";

type PollRow = typeof timePolls.$inferSelect;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";
const token = () => randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 20);

function parseAnswers(raw: string): Record<string, PollAnswer> {
  try { return JSON.parse(raw) as Record<string, PollAnswer>; } catch { return {}; }
}

async function loadPoll(deps: Deps, poll: PollRow, withEmails: boolean) {
  const options = await deps.db.select().from(timePollOptions).where(eq(timePollOptions.pollId, poll.id)).orderBy(asc(timePollOptions.startsAt)).limit(POLL_MAX_OPTIONS).all();
  const votes = await deps.db.select().from(timePollVotes).where(eq(timePollVotes.pollId, poll.id)).orderBy(asc(timePollVotes.createdAt)).limit(POLL_MAX_VOTES).all();
  const parsed = votes.map((v) => ({ id: v.id, name: v.name, ...(withEmails ? { email: v.email } : {}), answers: parseAnswers(v.answers) }));
  const totals = pollTotals(options.map((o) => o.id), parsed);
  return {
    id: poll.id, title: poll.title, description: poll.description, location: poll.location, durationMin: poll.durationMin, timezone: poll.timezone, video: poll.video,
    status: poll.status, winnerOptionId: poll.winnerOptionId, meetingId: poll.meetingId, deadlineAt: poll.deadlineAt?.toISOString() ?? null,
    url: `${deps.config.appUrl}/book/poll/${poll.token}`,
    options: options.map((o) => ({ id: o.id, startsAt: o.startsAt.toISOString() })), votes: parsed, totals, best: bestOption(totals),
  };
}

async function pollRow(deps: Deps, actor: SuiteActor, id: string) {
  const p = await deps.db.select().from(timePolls).where(and(eq(timePolls.id, id), eq(timePolls.orgId, actor.orgId))).get();
  if (!p) throw notFound("Poll");
  return p;
}
function assertOwner(actor: SuiteActor, p: PollRow) {
  if (p.createdBy !== actor.userId && !isAdmin(actor)) throw new HttpError(403, "forbidden", "Only the person who made this poll can change it.");
}

export interface PollInput { title: string; description?: string; location?: string; durationMin?: number; timezone?: string; video?: boolean; options: string[]; deadlineAt?: string | null }

function cleanOptions(deps: Deps, raw: string[]) {
  const now = deps.now().getTime();
  const set = new Set<number>();
  for (const s of raw) {
    const t = new Date(s).getTime();
    if (Number.isNaN(t)) throw new HttpError(422, "validation_failed", "One of the times is not valid.");
    if (t < now) throw new HttpError(422, "validation_failed", "Every time must be in the future.");
    set.add(t);
  }
  if (set.size < 1) throw new HttpError(422, "validation_failed", "Add at least one time.");
  if (set.size > POLL_MAX_OPTIONS) throw new HttpError(422, "validation_failed", `A poll can have up to ${POLL_MAX_OPTIONS} times.`);
  return [...set].sort((a, b) => a - b);
}

export async function createPoll(deps: Deps, actor: SuiteActor, input: PollInput) {
  assertBookingPlus(deps);
  assertWritable(actor);
  const title = input.title.trim().slice(0, 120);
  if (!title) throw new HttpError(422, "validation_failed", "Give the poll a title.");
  const tz = input.timezone ?? "UTC";
  if (!validTimezone(tz)) throw new HttpError(422, "validation_failed", "Pick a valid time zone.");
  const times = cleanOptions(deps, input.options);
  const now = deps.now();
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(timePolls).where(and(eq(timePolls.orgId, actor.orgId), eq(timePolls.status, "open"))).get();
  if ((count?.n ?? 0) >= 100) throw new HttpError(422, "limit_reached", "Close some open polls first (up to 100 open at once).");
  const id = sortableId("tpl", now.getTime());
  await deps.db.insert(timePolls).values({
    id, orgId: actor.orgId, createdBy: actor.userId, token: token(), title, description: (input.description ?? "").trim().slice(0, 2000), location: (input.location ?? "").trim().slice(0, 200),
    durationMin: Math.max(15, Math.min(480, input.durationMin ?? 30)), timezone: tz, video: input.video ?? true, deadlineAt: input.deadlineAt ? new Date(input.deadlineAt) : null, createdAt: now, updatedAt: now,
  });
  await deps.db.insert(timePollOptions).values(times.map((t, i) => ({ id: sortableId("tpo", now.getTime() + i), pollId: id, startsAt: new Date(t) })));
  return { poll: await loadPoll(deps, await pollRow(deps, actor, id), true) };
}

export async function listPolls(deps: Deps, actor: SuiteActor) {
  assertBookingPlus(deps);
  const rows = await deps.db.select({ p: timePolls, votes: sql<number>`(select count(*) from time_poll_votes v where v.poll_id = ${timePolls.id})`, options: sql<number>`(select count(*) from time_poll_options o where o.poll_id = ${timePolls.id})` })
    .from(timePolls).where(eq(timePolls.orgId, actor.orgId)).orderBy(desc(timePolls.createdAt)).limit(100).all();
  return rows.map(({ p, votes, options }) => ({ id: p.id, title: p.title, status: p.status, votes: Number(votes), options: Number(options), createdAt: p.createdAt.toISOString(), mine: p.createdBy === actor.userId, url: `${deps.config.appUrl}/book/poll/${p.token}` }));
}

export async function pollDetail(deps: Deps, actor: SuiteActor, id: string) {
  assertBookingPlus(deps);
  return { poll: await loadPoll(deps, await pollRow(deps, actor, id), true) };
}

export async function setPollOpen(deps: Deps, actor: SuiteActor, id: string, open: boolean) {
  assertBookingPlus(deps);
  const p = await pollRow(deps, actor, id);
  assertOwner(actor, p);
  if (open && p.meetingId) throw new HttpError(409, "decided", "A time was already picked for this poll.");
  await deps.db.update(timePolls).set({ status: open ? "open" : "closed", updatedAt: deps.now() }).where(eq(timePolls.id, id));
  return { poll: await loadPoll(deps, await pollRow(deps, actor, id), true) };
}

export async function deletePoll(deps: Deps, actor: SuiteActor, id: string) {
  assertBookingPlus(deps);
  const p = await pollRow(deps, actor, id);
  assertOwner(actor, p);
  await deps.db.delete(timePolls).where(eq(timePolls.id, id));
  return { ok: true };
}

/** Picks the winning time: makes the meeting, closes the poll and mails voters who left an email. */
export async function pickWinner(deps: Deps, actor: SuiteActor, id: string, optionId: string) {
  assertBookingPlus(deps);
  assertWritable(actor);
  const p = await pollRow(deps, actor, id);
  assertOwner(actor, p);
  if (p.meetingId) throw new HttpError(409, "decided", "A time was already picked for this poll.");
  const opt = await deps.db.select().from(timePollOptions).where(and(eq(timePollOptions.id, optionId), eq(timePollOptions.pollId, p.id))).get();
  if (!opt) throw notFound("Time");
  const now = deps.now();
  const votes = await deps.db.select({ email: timePollVotes.email, answers: timePollVotes.answers }).from(timePollVotes).where(eq(timePollVotes.pollId, p.id)).limit(POLL_MAX_VOTES).all();
  const emails = [...new Set(votes.filter((v) => v.email && parseAnswers(v.answers)[opt.id] !== "no").map((v) => v.email))].slice(0, 100);
  const meetingId = sortableId("mtg", now.getTime());
  const guestToken = randomToken(18).replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  await deps.db.insert(meetings).values({
    id: meetingId, orgId: p.orgId, title: p.title, room: `multies-${meetingId.slice(4)}`, guestToken, startsAt: opt.startsAt, durationMin: p.durationMin, status: "scheduled",
    sourceType: "contact", sourceId: null, invitees: JSON.stringify(emails), createdByType: "member", createdById: actor.userId, createdAt: now, updatedAt: now,
  });
  const done = await deps.db.update(timePolls).set({ status: "closed", winnerOptionId: opt.id, meetingId, updatedAt: now }).where(and(eq(timePolls.id, p.id), sql`${timePolls.meetingId} is null`)).returning({ id: timePolls.id });
  if (!done.length) {
    await deps.db.delete(meetings).where(eq(meetings.id, meetingId));
    throw new HttpError(409, "decided", "A time was already picked for this poll.");
  }
  const host = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, actor.userId)).get();
  const when = new Intl.DateTimeFormat("en-AU", { timeZone: p.timezone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(opt.startsAt);
  const guestUrl = p.video ? `${deps.config.appUrl}/m/${guestToken}` : null;
  const { sendSystemEmail } = await import("../system-mail");
  let mailed = 0;
  for (const to of emails) {
    const r = await sendSystemEmail(deps, {
      to, orgId: p.orgId, template: "poll-decided", subject: `${p.title}: ${when}`,
      text: `${host?.name ?? "The host"} picked a time for ${p.title}.\n\n${when} (${p.durationMin} minutes)${p.location ? `\n${p.location}` : ""}${guestUrl ? `\n\nJoin the video call: ${guestUrl}` : ""}`,
      ...(guestUrl ? { action: { label: "Join the call", url: guestUrl } } : {}),
    }).catch((err) => { deps.reportError?.(err, { where: "poll_decided_email" }); return null; });
    if (r?.delivered) mailed++;
  }
  return { poll: await loadPoll(deps, await pollRow(deps, actor, id), true), meetingId, mailed };
}

/* Public side: /book/poll/<token> */

async function publicPollRow(deps: Deps, tok: string) {
  assertBookingPlus(deps);
  if (!/^[A-Za-z0-9]{8,40}$/.test(tok)) throw notFound("Poll");
  const p = await deps.db.select().from(timePolls).where(eq(timePolls.token, tok)).get();
  if (!p) throw notFound("Poll");
  return p;
}
function pollIsOpen(deps: Deps, p: PollRow) {
  return p.status === "open" && (!p.deadlineAt || p.deadlineAt.getTime() > deps.now().getTime());
}

export async function publicPoll(deps: Deps, tok: string) {
  const p = await publicPollRow(deps, tok);
  const view = await loadPoll(deps, p, false);
  const host = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, p.createdBy)).get();
  const { url: _url, meetingId: _m, ...rest } = view;
  return { poll: { ...rest, open: pollIsOpen(deps, p), host: host?.name ?? "" } };
}

function cleanVote(input: { name: string; email?: string; answers: Record<string, string> }, optionIds: Set<string>) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new HttpError(422, "validation_failed", "Enter your name.");
  const email = (input.email ?? "").trim().toLowerCase();
  if (email && (!EMAIL.test(email) || email.length > 200)) throw new HttpError(422, "validation_failed", "Enter a valid email address or leave it empty.");
  const answers: Record<string, PollAnswer> = {};
  for (const [k, v] of Object.entries(input.answers ?? {})) {
    if (!optionIds.has(k)) continue;
    if (!POLL_ANSWERS.includes(v as PollAnswer)) throw new HttpError(422, "validation_failed", "Answer Yes, If need be or No.");
    answers[k] = v as PollAnswer;
  }
  if (!Object.keys(answers).length) throw new HttpError(422, "validation_failed", "Answer at least one time.");
  return { name, email, answers };
}

export async function castVote(deps: Deps, tok: string, input: { name: string; email?: string; answers: Record<string, string> }) {
  const p = await publicPollRow(deps, tok);
  if (!pollIsOpen(deps, p)) throw new HttpError(409, "closed", "This poll is closed.");
  const opts = await deps.db.select({ id: timePollOptions.id }).from(timePollOptions).where(eq(timePollOptions.pollId, p.id)).limit(POLL_MAX_OPTIONS).all();
  const v = cleanVote(input, new Set(opts.map((o) => o.id)));
  const n = await deps.db.select({ n: sql<number>`count(*)` }).from(timePollVotes).where(eq(timePollVotes.pollId, p.id)).get();
  if ((n?.n ?? 0) >= POLL_MAX_VOTES) throw new HttpError(409, "full", "This poll has all the answers it can take.");
  const now = deps.now();
  const editToken = token();
  const id = sortableId("tpv", now.getTime());
  await deps.db.insert(timePollVotes).values({ id, pollId: p.id, name: v.name, email: v.email, answers: JSON.stringify(v.answers), editTokenHash: await sha256Hex(editToken), createdAt: now, updatedAt: now });
  try {
    const { notify } = await import("../suite/notify");
    await notify(deps, p.orgId, p.createdBy, { type: "poll.voted", entityType: "meeting", entityId: p.id, title: `${v.name} answered ${p.title}`, actorName: v.name });
  } catch { /* a missing notice never fails the vote */ }
  return { voteId: id, editToken, ...(await publicPoll(deps, tok)) };
}

export async function editVote(deps: Deps, tok: string, voteId: string, input: { editToken: string; name: string; email?: string; answers: Record<string, string> }) {
  const p = await publicPollRow(deps, tok);
  if (!pollIsOpen(deps, p)) throw new HttpError(409, "closed", "This poll is closed.");
  const row = await deps.db.select().from(timePollVotes).where(and(eq(timePollVotes.id, voteId), eq(timePollVotes.pollId, p.id))).get();
  if (!row || !input.editToken || (await sha256Hex(input.editToken)) !== row.editTokenHash) throw notFound("Answer");
  const opts = await deps.db.select({ id: timePollOptions.id }).from(timePollOptions).where(eq(timePollOptions.pollId, p.id)).limit(POLL_MAX_OPTIONS).all();
  const v = cleanVote({ ...input, email: input.email ?? row.email }, new Set(opts.map((o) => o.id)));
  await deps.db.update(timePollVotes).set({ name: v.name, email: v.email, answers: JSON.stringify(v.answers), updatedAt: deps.now() }).where(eq(timePollVotes.id, row.id));
  return { voteId: row.id, ...(await publicPoll(deps, tok)) };
}
