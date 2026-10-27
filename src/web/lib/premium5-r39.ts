/**
 * R39 premium pass 5: the small pure rules behind the mailbox kind pills, the plain word status pills on
 * deliverability and connections, and the team headline numbers. Kept apart from the pages so they are unit tested
 * (tests/premium5-r39.test.ts).
 */

export type MailboxKind = "personal" | "shared" | "agent";
export const MAILBOX_KIND_LABELS: Record<MailboxKind, string> = { personal: "Personal", shared: "Shared", agent: "Agent" };

/** Role addresses read as shared even before anyone else is given access. */
const ROLE_LOCAL_PARTS = new Set(["admin", "billing", "contact", "hello", "help", "hi", "info", "jobs", "office", "press", "sales", "support", "team", "accounts", "careers", "orders"]);

/**
 * What kind of mailbox this is, from who can open it: an agent member has it in their list, so Agent; two or more
 * people were given it, or the address is a role address (sales@, support@), so Shared; otherwise Personal.
 * Owners and admins open every mailbox (a null list) and are not counted.
 */
export function mailboxKind(mailbox: { id: string; localPart: string }, members: { kind: "human" | "agent"; mailboxIds: string[] | null }[]): MailboxKind {
  if (members.some((m) => m.kind === "agent" && m.mailboxIds?.includes(mailbox.id))) return "agent";
  const people = members.filter((m) => m.kind === "human" && m.mailboxIds?.includes(mailbox.id)).length;
  if (people >= 2 || ROLE_LOCAL_PARTS.has(mailbox.localPart.toLowerCase())) return "shared";
  return "personal";
}

export type PlainStatus = "good" | "check" | "unset";
export const PLAIN_STATUS_LABELS: Record<PlainStatus, string> = { good: "Good", check: "Check this", unset: "Not set up" };

/** A deliverability factor in plain words: good is Good, a warning or a failure is Check this, unknown is Not set up. */
export function factorStatus(status: "good" | "warn" | "bad" | "unknown"): PlainStatus {
  return status === "good" ? "good" : status === "unknown" ? "unset" : "check";
}

/** A connected mailbox in plain words and the one next step to take, or null when there is nothing to do. */
export function connectionStatus(status: "active" | "syncing" | "auth_failed" | "error" | "paused"): { status: PlainStatus; next: string | null } {
  switch (status) {
    case "active": case "syncing": return { status: "good", next: null };
    case "auth_failed": return { status: "check", next: "Reconnect with a new app password from your provider." };
    case "error": return { status: "check", next: "Sync now. If it keeps failing, check the server name and port with your provider." };
    case "paused": return { status: "check", next: "Sync now to start copying new mail again." };
  }
}

/** The three numbers at the top of Team: people, pending invitations, and seats left (never below 0). */
export function teamHeadline(input: { members: number; pendingInvites: number; limit: number }): { people: number; pending: number; seatsLeft: number } {
  return { people: input.members, pending: input.pendingInvites, seatsLeft: Math.max(0, input.limit - input.members - input.pendingInvites) };
}
