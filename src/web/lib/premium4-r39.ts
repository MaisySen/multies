/**
 * R39 premium pass 4: the small pure rules behind the billing rings, the domain stepper and record pills,
 * and the notification kind tiles. Kept apart from the pages so they are unit tested (tests/premium4-r39.test.ts).
 */
import type { DnsCheckStatus } from "@/shared/dns";

export type RingTone = "brand" | "warn" | "bad";

/** How full a usage ring is, 0 to 100, and its colour: brand under 70 %, amber to 90 %, red above. */
export function usageRing(used: number, max: number): { pct: number; tone: RingTone; over: boolean } {
  const pct = max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : used > 0 ? 100 : 0;
  return { pct, tone: pct > 90 ? "bad" : pct > 70 ? "warn" : "brand", over: max > 0 && used > max };
}

export type RecordPill = "verified" | "pending" | "wrong" | "warning";
export const RECORD_PILL_LABELS: Record<RecordPill, string> = { verified: "Verified", pending: "Pending", wrong: "Wrong value", warning: "Check this" };

/**
 * One DNS record's status in plain words. Pass is Verified; a failing record with something found at the host is a
 * Wrong value; nothing found yet, a lookup error or no check at all is Pending; a soft warning is Check this.
 */
export function recordPill(check: { status: DnsCheckStatus; found: string[] } | undefined): RecordPill {
  if (!check) return "pending";
  if (check.status === "pass") return "verified";
  if (check.status === "warn") return "warning";
  if (check.status === "fail" && check.found.length > 0) return "wrong";
  return "pending";
}

export interface SetupStep { id: "added" | "records" | "verified" | "mailbox"; label: string; done: boolean }

/** The 4 setup steps of a domain and which one is next (index of the first not done, or -1 when all are). */
export function domainSteps(input: { status: "pending" | "verified" | "failed"; passing: number; required: number; mailboxes: number }): { steps: SetupStep[]; current: number } {
  const verified = input.status === "verified";
  const steps: SetupStep[] = [
    { id: "added", label: "Add domain", done: true },
    { id: "records", label: "Add DNS records", done: verified || (input.required > 0 && input.passing >= input.required) },
    { id: "verified", label: "Verified", done: verified },
    { id: "mailbox", label: "First mailbox", done: verified && input.mailboxes > 0 },
  ];
  return { steps, current: steps.findIndex((s) => !s.done) };
}

/** Initials for a person's small avatar badge: first letters of the first two words, upper case. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}

/** Notification filter chips remember their choice per device (the notes app's "your filter choices stick"). */
export const NOTIFICATION_FILTER_KEY = "multies-ntf-filter";
export function readStoredFilter<T extends string>(allowed: readonly T[], fallback: T, storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): T {
  try { const v = storage?.getItem(NOTIFICATION_FILTER_KEY); return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback; } catch { return fallback; }
}
