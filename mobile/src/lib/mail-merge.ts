/**
 * M1 (1.10.9): Mail merge status on the phone (web Tools > Mail merge, flag merge_plus_r109). Newsletters, lists and
 * journeys in the server's shapes, read only apart from Pause, Resume, Send test to me and journey Pause and Start,
 * each allowed exactly where the server allows it (canSend comes from the server for this person). Writing stays on the web.
 */
export type NewsletterStatus = "draft" | "scheduled" | "sending" | "sent" | "paused" | "cancelled";
export type JourneyStatus = "draft" | "active" | "paused";

export interface NewsletterStats { total: number; sent: number; failed: number; skipped: number; opened: number; clicked: number; unsubscribed: number; bounced: number }
export interface NewsletterView {
  id: string; name: string; subject: string; status: NewsletterStatus; listId: string; listName: string; mailboxId: string | null;
  scheduledAt: string | null; sentAt: string | null; error: string | null; stats: NewsletterStats; updatedAt: string; canSend?: boolean;
}
export interface MergeListView {
  id: string; name: string; description?: string | null; visibility: "workspace" | "private"; mine: boolean; canSend: boolean;
  subscribed: number; pending: number; unsubscribed: number; bounced: number; updatedAt: string;
}
export interface JourneyStepStat { name: string; total: number; sent: number; opened: number; clicked: number; unsubscribed: number }
export interface JourneyView {
  id: string; name: string; status: JourneyStatus; listId: string; listName: string; mailboxId: string | null; steps: unknown[]; enrolled: number;
  updatedAt: string; canSend?: boolean; active?: number; stepStats?: JourneyStepStat[];
}
export interface NewslettersResponse { newsletters: NewsletterView[] }
export interface ListsResponse { lists: MergeListView[] }
export interface JourneysResponse { journeys: JourneyView[] }

export const MERGE_FEATURE = "merge_plus_r109";
export const MERGE_WEB = "/app/tools/merge";

export const NEWSLETTER_STATUS: Record<NewsletterStatus, { label: string; tone: "brand" | "ok" | "warn" | "bad" | "neutral" }> = {
  draft: { label: "Draft", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "brand" },
  sending: { label: "Sending", tone: "brand" },
  sent: { label: "Sent", tone: "ok" },
  paused: { label: "Paused", tone: "warn" },
  cancelled: { label: "Stopped", tone: "bad" },
};
export const JOURNEY_STATUS: Record<JourneyStatus, { label: string; tone: "brand" | "ok" | "warn" | "bad" | "neutral" }> = {
  draft: { label: "Draft", tone: "neutral" },
  active: { label: "On", tone: "ok" },
  paused: { label: "Paused", tone: "warn" },
};

export const statusOf = (s: string) => NEWSLETTER_STATUS[s as NewsletterStatus] ?? { label: s, tone: "neutral" as const };
export const journeyStatusOf = (s: string) => JOURNEY_STATUS[s as JourneyStatus] ?? { label: s, tone: "neutral" as const };

/** What this person may do to a newsletter on the phone: the server's own rules (pause only while sending, resume only when paused). */
export function newsletterActions(n: Pick<NewsletterView, "status" | "canSend" | "mailboxId">) {
  const can = n.canSend === true;
  return { pause: can && n.status === "sending", resume: can && n.status === "paused", test: !!n.mailboxId };
}

/** Journey Pause while on, Start while a draft or paused; only for people the server lets send to that list. */
export function journeyActions(j: Pick<JourneyView, "status" | "canSend">) {
  const can = j.canSend === true;
  return { pause: can && j.status === "active", start: can && j.status !== "active" };
}

const n = (v: number) => v.toLocaleString("en-AU");

/** One plain line under a newsletter in the list. */
export function newsletterLine(v: NewsletterView): string {
  const s = v.stats;
  if (v.status === "draft") return v.listName ? `To ${v.listName}` : "Not sent yet";
  if (v.status === "scheduled") return v.scheduledAt ? `Sends ${shortDate(v.scheduledAt)}` : "Scheduled";
  if (v.status === "sending" || v.status === "paused") return `${n(s.sent)} of ${n(s.total)} sent`;
  if (v.status === "sent") return `${n(s.sent)} sent, ${n(s.opened)} opened`;
  return `${n(s.sent)} sent before it stopped`;
}

export function listLine(l: MergeListView): string {
  const parts = [`${n(l.subscribed)} subscribed`];
  if (l.pending) parts.push(`${n(l.pending)} waiting to confirm`);
  if (l.unsubscribed) parts.push(`${n(l.unsubscribed)} unsubscribed`);
  return parts.join(", ");
}

/** Share of sent mail, as a whole percent; 0 when nothing was sent. */
export const pct = (part: number, of: number) => (of > 0 ? Math.round((part / of) * 100) : 0);

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
