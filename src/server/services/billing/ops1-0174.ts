/**
 * OPS1-0174: the one place that knows about migration 0174 (organizations.comp_until, organizations.comp_note,
 * billing_events.summary). Everything that reads or writes those columns goes through the helpers below.
 *
 * Before 0174 is in the schema the helpers write nothing (Drizzle ignores keys that are not columns of the table),
 * read null and report `OPS1_0174.comp` / `OPS1_0174.eventSummary` as false. Once the columns are in schema.ts they
 * switch on by themselves, because the checks look at the Drizzle table objects. After the merge the integrator may
 * replace the untyped lookups with `organizations.compUntil`, `organizations.compNote` and `billingEvents.summary`.
 */
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { billingEvents, organizations } from "../../db/schema";
import { formatCents } from "@/shared/money";

type OrgInsert = typeof organizations.$inferInsert;
type EventInsert = typeof billingEvents.$inferInsert;

// OPS1-0174: untyped column lookups, so this file compiles with or without the 0174 columns in schema.ts.
const orgColumns = organizations as unknown as Record<string, SQLiteColumn | undefined>;
const eventColumns = billingEvents as unknown as Record<string, SQLiteColumn | undefined>;

/** Whether the 0174 columns are in the schema. */
export const OPS1_0174: { readonly comp: boolean; readonly eventSummary: boolean } = {
  comp: !!orgColumns.compUntil && !!orgColumns.compNote,
  eventSummary: !!eventColumns.summary,
};

/** organizations.comp_until, or null before 0174. */
export function compUntilColumn(): SQLiteColumn | null {
  return OPS1_0174.comp ? orgColumns.compUntil ?? null : null;
}

/** billing_events.summary, or null before 0174. */
export function eventSummaryColumn(): SQLiteColumn | null {
  return OPS1_0174.eventSummary ? eventColumns.summary ?? null : null;
}

/** The comp end date and note to spread into an organizations insert or update. Empty before 0174. */
export function compExpiryFields(until: Date | null, note: string | null): Partial<OrgInsert> {
  if (!OPS1_0174.comp) return {};
  return { compUntil: until, compNote: note } as unknown as Partial<OrgInsert>;
}

/** The comp end date and note of a workspace row; null before 0174. */
export function readCompExpiry(org: object): { compUntil: Date | null; compNote: string | null } {
  if (!OPS1_0174.comp) return { compUntil: null, compNote: null };
  const o = org as { compUntil?: Date | null; compNote?: string | null };
  return { compUntil: o.compUntil ?? null, compNote: o.compNote ?? null };
}

/** The summary to spread into a billing_events insert. Empty before 0174. */
export function billingEventSummaryField(summary: string | null): Partial<EventInsert> {
  if (!OPS1_0174.eventSummary || !summary) return {};
  return { summary } as unknown as Partial<EventInsert>;
}

const SUMMARY_MAX = 200;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A short plain summary of a Stripe event for the operator console: what happened, the amount and the status. Never
 * card details, customer contact details or secrets: only the fields named here are read.
 */
export function summarizeStripeEvent(type: string, obj: Record<string, unknown> | null | undefined): string | null {
  const o = obj ?? {};
  const currency = str(o.currency);
  let out: string | null;
  switch (type) {
    case "invoice.paid":
    case "invoice.payment_failed": {
      const amount = num(type === "invoice.paid" ? o.amount_paid ?? o.amount_due : o.amount_due);
      const number = str(o.number);
      out = `Invoice${number ? ` ${number}` : ""} ${type === "invoice.paid" ? "paid" : "payment failed"}${amount != null ? `: ${formatCents(amount, currency)}` : ""}`;
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const status = str(o.status);
      const verb = type.endsWith("created") ? "created" : type.endsWith("deleted") ? "deleted" : "updated";
      out = `Subscription ${verb}${status ? `, status ${status}` : ""}${o.cancel_at_period_end === true ? ", cancels at period end" : ""}`;
      break;
    }
    case "checkout.session.completed":
      out = "Checkout completed";
      break;
    case "charge.refunded": {
      const amount = num(o.amount_refunded);
      out = `Charge refunded${amount != null ? `: ${formatCents(amount, currency)}` : ""}`;
      break;
    }
    default:
      out = null;
  }
  return out && out.length > SUMMARY_MAX ? out.slice(0, SUMMARY_MAX) : out;
}
