/**
 * R31: read status on sent mail, opt in per person (Settings > Mail, off by default). When it is on, mail that
 * leaves Multies carries a 1x1 image at /r/o/<token>.gif. The token is random and maps to the sent message; the
 * URL carries nothing about the sender or recipient. Writes stay cheap on D1: one row per tracked message, and at
 * most one update a minute per message (a burst of opens counts once). Opens in the first 10 seconds and from
 * scanners and link checkers are ignored.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailOpens, mailPrefs, messages } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { inChunks, inIds } from "../../lib/sql-chunks";
import type { ReadStatus } from "@/shared/mail-splits";

export const OPEN_GRACE_MS = 10_000;
export const OPEN_WRITE_EVERY_MS = 60_000;
/** A transparent 1x1 GIF. */
export const PIXEL_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

/** Scanners, link checkers, our own fetches and preview bots: not a person opening the mail. */
const NOT_A_PERSON = /(bot\b|bot\/|crawler|spider|preview|scanner|barracuda|mimecast|proofpoint|symantec|trendmicro|forcepoint|messagelabs|ironport|safelinks|curl\/|wget|python-requests|go-http-client|node-fetch|undici|axios|headless|multies)/i;
export function isScannerAgent(ua: string | undefined | null): boolean {
  if (!ua || !ua.trim()) return true;
  return NOT_A_PERSON.test(ua);
}

export interface PrefActor { orgId: string; userId: string; agentId?: string | null; scope?: string }

export async function getMailPrefs(deps: Deps, a: PrefActor) {
  if (!a.userId) return { readStatus: false };
  const row = await deps.db.select().from(mailPrefs).where(and(eq(mailPrefs.orgId, a.orgId), eq(mailPrefs.userId, a.userId))).get();
  return { readStatus: row?.readStatus ?? false };
}

export async function setMailPrefs(deps: Deps, a: PrefActor, patch: { readStatus?: boolean }) {
  if (!a.userId || a.agentId) throw new HttpError(403, "person_only", "Mail settings belong to a person.");
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
  if (patch.readStatus !== undefined) {
    const now = deps.now();
    await deps.db.insert(mailPrefs).values({ orgId: a.orgId, userId: a.userId, readStatus: patch.readStatus, updatedAt: now })
      .onConflictDoUpdate({ target: [mailPrefs.orgId, mailPrefs.userId], set: { readStatus: patch.readStatus, updatedAt: now } });
  }
  return getMailPrefs(deps, a);
}

function randomToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The open token for a sent message when its sender has read status on, else null. One row per message. */
export async function trackingToken(deps: Deps, s: { orgId: string; userId: string | null | undefined; messageId: string; agentId?: string | null }): Promise<string | null> {
  if (!s.userId || s.agentId) return null;
  const prefs = await getMailPrefs(deps, { orgId: s.orgId, userId: s.userId });
  if (!prefs.readStatus) return null;
  const existing = await deps.db.select({ token: mailOpens.token }).from(mailOpens).where(eq(mailOpens.messageId, s.messageId)).get();
  if (existing) return existing.token;
  const token = randomToken();
  await deps.db.insert(mailOpens).values({ token, orgId: s.orgId, messageId: s.messageId, userId: s.userId, createdAt: deps.now() });
  return token;
}

/** The token a sent message already has (a retry sends the same image). */
export async function existingToken(deps: Deps, messageId: string): Promise<string | null> {
  const row = await deps.db.select({ token: mailOpens.token }).from(mailOpens).where(eq(mailOpens.messageId, messageId)).get();
  return row?.token ?? null;
}

export const pixelUrl = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/r/o/${token}.gif`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML part with the open image added (a plain text message gets a simple HTML part too). */
export function withPixel(html: string | undefined, text: string, url: string): string {
  const img = `<img src="${esc(url)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
  if (html && html.trim()) {
    const i = html.toLowerCase().lastIndexOf("</body>");
    return i >= 0 ? `${html.slice(0, i)}${img}${html.slice(i)}` : `${html}${img}`;
  }
  return `<div style="white-space:pre-wrap;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">${esc(text)}</div>${img}`;
}

/** Records an open. Returns what happened, for tests and logs; the image answers the same either way. */
export async function recordOpen(deps: Deps, token: string, ua: string | undefined | null): Promise<"counted" | "unknown" | "too_soon" | "scanner" | "throttled"> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return "unknown";
  const row = await deps.db.select().from(mailOpens).where(eq(mailOpens.token, token)).get();
  if (!row) return "unknown";
  const now = deps.now();
  if (now.getTime() - row.createdAt.getTime() < OPEN_GRACE_MS) return "too_soon";
  if (isScannerAgent(ua)) return "scanner";
  if (row.lastOpenAt && now.getTime() - row.lastOpenAt.getTime() < OPEN_WRITE_EVERY_MS) return "throttled";
  await deps.db.update(mailOpens).set({ opens: row.opens + 1, firstOpenAt: row.firstOpenAt ?? now, lastOpenAt: now }).where(eq(mailOpens.token, token));
  return "counted";
}

const present = (r: typeof mailOpens.$inferSelect | undefined): ReadStatus =>
  r ? { tracked: true, opens: r.opens, firstOpenAt: r.firstOpenAt?.toISOString() ?? null, lastOpenAt: r.lastOpenAt?.toISOString() ?? null }
    : { tracked: false, opens: 0, firstOpenAt: null, lastOpenAt: null };

/** Read status for many sent messages (chunked for D1's variable limit). */
export async function readStatusFor(deps: Deps, orgId: string, messageIds: string[]): Promise<Map<string, ReadStatus>> {
  const rows = await inChunks(messageIds, (ids) => deps.db.select().from(mailOpens).where(and(eq(mailOpens.orgId, orgId), inIds(mailOpens.messageId, ids))));
  const by = new Map(rows.map((r) => [r.messageId, r]));
  return new Map(messageIds.map((id) => [id, present(by.get(id))]));
}

/** Read status of one sent message the caller can open. */
export async function readStatusOf(deps: Deps, a: { orgId: string }, messageId: string, scope: string[] | null) {
  const m = await deps.db.select({ id: messages.id, mailboxId: messages.mailboxId, folder: messages.folder, subject: messages.subject }).from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.orgId, a.orgId))).get();
  if (!m || (scope && !scope.includes(m.mailboxId))) throw notFound("Message");
  const s = (await readStatusFor(deps, a.orgId, [m.id])).get(m.id)!;
  return { messageId: m.id, subject: m.subject, folder: m.folder, ...s };
}
