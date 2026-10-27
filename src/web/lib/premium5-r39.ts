/**
 * R39 premium pass 5: the small pure rules behind the mailbox kind pills, the plain word status pills on
 * deliverability and connections, and the team headline numbers. Kept apart from the pages so they are unit tested
 * (tests/premium5-r39.test.ts).
 */

export type MailboxKind = "personal" | "shared" | "agent";
export const MAILBOX_KIND_LABELS: Record<MailboxKind, string> = { personal: "Personal", shared: "Shared", agent: "Agent" };

/**
 * Role addresses read as shared even before anyone else is given access. This is the one list of shared role
 * names in the web app: add new names here (tests/premium5-r39.test.ts checks it). Matching ignores case and
 * a trailing plus tag or dot suffix, so Founders, sales+eu and info.nz all read as shared.
 */
export const ROLE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "accounts", "accounting", "admin", "billing", "bookings", "careers", "community", "contact", "crew", "design",
  "dev", "enquiries", "events", "finance", "founders", "hello", "help", "hi", "hr", "info", "inquiries", "invoices",
  "jobs", "legal", "marketing", "media", "news", "newsletter", "office", "ops", "orders", "partners", "payments",
  "people", "press", "privacy", "reception", "recruiting", "sales", "security", "service", "shop", "social",
  "staff", "studio", "success", "support", "team", "welcome",
]);

/** True when a mailbox local part is a common shared role address (sales@, founders@, info@). */
export function isRoleLocalPart(localPart: string): boolean {
  const base = localPart.toLowerCase().trim().split("+")[0]!.split(".")[0]!;
  return ROLE_LOCAL_PARTS.has(base);
}

/**
 * What kind of mailbox this is, from who can open it: an agent member has it in their list, so Agent; two or more
 * people were given it, or the address is a role address (sales@, support@), so Shared; otherwise Personal.
 * Owners and admins open every mailbox (a null list) and are not counted.
 */
export function mailboxKind(mailbox: { id: string; localPart: string }, members: { kind: "human" | "agent"; mailboxIds: string[] | null }[]): MailboxKind {
  if (members.some((m) => m.kind === "agent" && m.mailboxIds?.includes(mailbox.id))) return "agent";
  const people = members.filter((m) => m.kind === "human" && m.mailboxIds?.includes(mailbox.id)).length;
  if (people >= 2 || isRoleLocalPart(mailbox.localPart)) return "shared";
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
