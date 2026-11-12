/**
 * PRIV1b (P66): what the web client offers in a mailbox, from the viewer's level there. The server is the rule
 * (mail-access-priv1a.ts); this only keeps the screen from offering what it would refuse.
 * - GET /api/mail/overview gives `level` per mailbox: own, send_as, reply, read or team.
 * - GET /api/mailboxes gives `openable`: false for a personal mailbox the viewer can't open (admins see it as a row).
 * A row with no level (an older server, or a /api/mailboxes row) counts as full access unless it is not openable.
 */
export type MailboxLevel = "own" | "send_as" | "reply" | "read" | "team";
export interface LevelBox { id: string; level?: MailboxLevel; openable?: boolean; personal?: boolean }

const RANK: Record<MailboxLevel, number> = { read: 1, reply: 2, send_as: 3, own: 9, team: 9 };
const rank = (b: LevelBox | undefined) => (!b || b.openable === false ? 0 : b.level ? RANK[b.level] ?? 0 : 9);

/** Archive, delete, snooze, spam, star, labels, read state: a reply share or more (a read share changes nothing). */
export const canChangeMail = (b: LevelBox | undefined) => rank(b) >= RANK.reply;
/** Reply in a thread of this mailbox. */
export const canReplyIn = (b: LevelBox | undefined) => rank(b) >= RANK.reply;
/** New mail (and forwards) from this mailbox: send as or more. */
export const canSendNewFrom = (b: LevelBox | undefined) => rank(b) >= RANK.send_as;

/** The From choices for a draft: mailboxes the person may send new mail from, plus the thread's own mailbox for a reply. */
export function fromChoices<B extends LevelBox>(boxes: B[], draft: { mailboxId: string; inReplyToId?: string }): B[] {
  return boxes.filter((b) => canSendNewFrom(b) || (!!draft.inReplyToId && b.id === draft.mailboxId && canReplyIn(b)));
}
/** The From a composer opens with: the asked one when allowed, else the first allowed, else none. */
export function defaultFrom(boxes: LevelBox[], draft: { mailboxId: string; inReplyToId?: string }): string {
  const ok = fromChoices(boxes, draft);
  return ok.some((b) => b.id === draft.mailboxId) ? draft.mailboxId : ok[0]?.id ?? "";
}

/** Mailboxes the viewer can open (palette, Open in mail, shared inbox). */
export const openableOnly = <B extends { openable?: boolean }>(list: B[] | undefined): B[] => (list ?? []).filter((b) => b.openable !== false);
/** Team pickers (invite, access): team mailboxes only; a grant on a personal mailbox counts for nothing and is refused. */
export const teamPickable = <B extends { openable?: boolean; personal?: boolean }>(list: B[] | undefined): B[] => openableOnly(list).filter((b) => !b.personal);

/** A mailbox read that answers 404: the share was taken back or left, so the mailbox leaves the screen. */
export const isGone = (e: unknown) => !!e && typeof e === "object" && (e as { status?: unknown }).status === 404;

/** The private-inbox notice is dismissed per person and workspace, not per browser. */
export const noticeKey = (userId: string | undefined, orgId: string | undefined) => `multies.priv1a.notice:${userId ?? ""}:${orgId ?? ""}`;

/**
 * PRIV1b (WC1): the mailbox Mail opens. The one in the URL loads at once, before the overview answers (it has no
 * offline copy, and the server answers 404 for a mailbox this person can't open, which drops it); once the overview
 * is in, a ?mailbox= missing from it is not used and the fallback (the busiest one) opens instead.
 */
export const pickMailbox = (wanted: string | null | undefined, overview: { id: string }[] | undefined, fallback: string | undefined): string =>
  (wanted && (!overview || overview.some((m) => m.id === wanted)) ? wanted : null) ?? fallback ?? "";

/** PRIV1b (WC2): From once the mailbox list is in: what the person chose, else the default (the list may arrive after Compose opened). */
export const fillFrom = (chosen: string, boxes: LevelBox[], draft: { mailboxId: string; inReplyToId?: string }): string =>
  chosen || defaultFrom(boxes, draft);

/** PRIV1b (WC4): the stored offline list copies of one mailbox (offline-lists keys are mail:<id>:<folder>:<split>). */
export const mailCopyPrefix = (mailboxId: string) => `mail:${mailboxId}:`;
