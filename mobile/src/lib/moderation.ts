import { ApiError } from "@/api/errors";
import type { ChatMessage } from "@/api/types";

/**
 * R35: report and block (App Store guideline 1.2, user generated content). Pure helpers, no React,
 * so the rules are unit tested. The screens live in components/moderation.tsx.
 *
 * Server contract (built on the web side in R35):
 * - POST /reports {targetType, messageId?, userId?, context?, reason, note?} answers 201 {id, status}
 * - GET /blocks {blocks: [{userId, name, avatarUrl, createdAt}]}, POST /blocks {userId}, DELETE /blocks/:userId
 * The server already leaves blocked people's messages out; the phone filters too, so a cached list,
 * a realtime event or an older server never shows them.
 */

export type ReportReason = "spam" | "harassment" | "hate" | "sexual" | "violence" | "self_harm" | "other";
export type ReportContext = "chat" | "meeting" | "dm";
export interface ReportInput {
  targetType: "message" | "user"; messageId?: string; userId?: string; context?: ReportContext; reason: ReportReason; note?: string;
}
export interface BlockedPerson { userId: string; name: string; avatarUrl: string | null; createdAt: string }

/** The reasons, in the order the sheet lists them. */
export const REPORT_REASONS: { id: ReportReason; label: string; hint: string }[] = [
  { id: "spam", label: "Spam or scam", hint: "Ads, fake offers, links you didn't ask for" },
  { id: "harassment", label: "Harassment or bullying", hint: "Insults, threats or targeting someone" },
  { id: "hate", label: "Hate speech", hint: "Attacks on who someone is" },
  { id: "sexual", label: "Sexual content", hint: "Nudity or sexual messages" },
  { id: "violence", label: "Violence or threats", hint: "Threats or praise of violence" },
  { id: "self_harm", label: "Self harm", hint: "Someone may be at risk" },
  { id: "other", label: "Something else", hint: "Tell us in the note" },
];

export const NOTE_MAX = 500;
export const REPORT_THANKS = "Thanks. Our team reviews reports within 24 hours.";
export const REPORT_FAILED = "Couldn't send. Try again later.";
export const HIDDEN_ROW = "Messages from people you blocked are hidden";
export const BLOCKED_DM = "You can't message this person.";

/** The words of the block confirm, naming the person. */
export function blockConfirm(name: string): { title: string; body: string; action: string } {
  return {
    title: `Block ${name}?`,
    body: "You won't see their messages and they can't message you. They won't be told.",
    action: "Block",
  };
}

/** What the person sees when a report did not go through. A 429 says why; everything else is the same plain line. */
export function reportErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return "You've sent a lot of reports today. Try again tomorrow.";
  return REPORT_FAILED;
}

/** The body to POST, trimmed and within the contract's limits. */
export function reportBody(input: ReportInput): ReportInput {
  const note = input.note?.trim().slice(0, NOTE_MAX);
  const out: ReportInput = { targetType: input.targetType, reason: input.reason };
  if (input.targetType === "message" && input.messageId) out.messageId = input.messageId;
  if (input.userId) out.userId = input.userId;
  if (input.context) out.context = input.context;
  if (note) out.note = note;
  return out;
}

/** True for the answer of a server that has no blocks endpoint yet (or an older one): menus stay, the list stays empty. */
export function isMissingEndpoint(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501);
}

/** True when a send or a new DM was refused because the other person blocked you (403 {"error":{"code":"blocked"}}). */
export function isBlockedError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && err.code === "blocked";
}

/** R36: the one line every send path shows for a blocked DM (the server's own words, nothing more). */
export const BLOCKED_TEXT = "You can't message this person.";

/** Words for a refused DM start or send: the blocked line for a block, else the server's message. */
export function dmErrorText(err: unknown): string {
  if (isBlockedError(err)) return BLOCKED_TEXT;
  return (err as Error)?.message || "Couldn't send. Try again.";
}

/** R36: DELETE /blocks/:userId answering 404 means there was no block, which is the state we wanted. */
export function isUnblockDone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * Chat ids carry a kind ("member:<userId>", "guest:<userId>"); blocks are by plain user id, the same
 * user across every workspace. This gives the user id for either form.
 */
export function userIdOf(chatId: string | null | undefined): string {
  if (!chatId) return "";
  const m = /^(member|guest|user):(.+)$/.exec(chatId);
  return m ? m[2] : chatId;
}

export function blockedIds(blocks: BlockedPerson[] | undefined | null): Set<string> {
  return new Set((blocks ?? []).map((b) => b.userId));
}

/**
 * Leaves out messages written by blocked people. Agents are never blocked (they belong to the
 * workspace, not to a person). Returns the kept list and whether anything was hidden, so the
 * screen can show the one quiet row (no count, per the contract).
 */
export function filterBlocked<M extends Pick<ChatMessage, "author">>(messages: M[], blocked: Set<string>): { messages: M[]; hidden: boolean } {
  if (!blocked.size) return { messages, hidden: false };
  const kept = messages.filter((m) => m.author.type === "agent" || !blocked.has(userIdOf(m.author.id)));
  return { messages: kept, hidden: kept.length !== messages.length };
}

/** Whether a realtime or push event should be dropped: it carries a message from someone you blocked. */
export function dropEvent(event: { authorId?: string | null; author?: { id: string } | null }, blocked: Set<string>): boolean {
  const id = event.authorId ?? event.author?.id;
  return !!id && blocked.has(userIdOf(id));
}

/** Who can be blocked from a message: a real person, not you, not an agent. */
export function canBlockAuthor(m: Pick<ChatMessage, "author">, meId: string | null): boolean {
  return m.author.type !== "agent" && !!m.author.id && m.author.id !== meId;
}

/** Adds or removes one person in a cached list, newest first, without duplicates. */
export function withBlock(list: BlockedPerson[], person: { userId: string; name: string; avatarUrl?: string | null }, now = new Date()): BlockedPerson[] {
  if (list.some((b) => b.userId === person.userId)) return list;
  return [{ userId: person.userId, name: person.name, avatarUrl: person.avatarUrl ?? null, createdAt: now.toISOString() }, ...list];
}
export function withoutBlock(list: BlockedPerson[], userId: string): BlockedPerson[] {
  return list.filter((b) => b.userId !== userId);
}
