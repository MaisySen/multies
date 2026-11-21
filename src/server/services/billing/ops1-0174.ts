/**
 * OPS1-0174: helpers for the columns migration 0174 added (organizations.comp_until, organizations.comp_note,
 * billing_events.summary), and the plain summary of a Stripe event stored in billing_events.summary.
 *
 * The migration is in, so these use the typed columns. `OPS1_0174` stays as a constant (both true) for callers and
 * tests written before the merge.
 */
import { billingEvents, organizations } from "../../db/schema";
import { formatCents } from "@/shared/money";

type Org = typeof organizations.$inferSelect;
type OrgUpdate = Pick<typeof organizations.$inferInsert, "compUntil" | "compNote">;
type EventInsert = Pick<typeof billingEvents.$inferInsert, "summary">;

/** Whether the 0174 columns are in the schema (they are). */
export const OPS1_0174: { readonly comp: boolean; readonly eventSummary: boolean } = { comp: true, eventSummary: true };

/** The comp end date and note to spread into an organizations insert or update. */
export function compExpiryFields(until: Date | null, note: string | null): OrgUpdate {
  return { compUntil: until, compNote: note };
}

/** The comp end date and note of a workspace row. */
export function readCompExpiry(org: Pick<Org, "compUntil" | "compNote">): { compUntil: Date | null; compNote: string | null } {
  return { compUntil: org.compUntil ?? null, compNote: org.compNote ?? null };
}

/** The summary to spread into a billing_events insert (nothing when there is no summary). */
export function billingEventSummaryField(summary: string | null): EventInsert {
  return summary ? { summary } : {};
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
