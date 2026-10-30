/**
 * R62: the discounts Multies offers, in one place: the pricing page, the billing settings, the terms and llms.txt
 * all read these, and the server enforces the same numbers. Guardrails (owner, 30 October 2026): no lifetime deals,
 * no discount over 50 percent, and the Free plan's limits never change.
 */
import { YEARLY_MONTHS_CHARGED } from "./plans";

/** The launch promotion code, redeemable at checkout. */
export const LAUNCH_CODE = "LAUNCH30";
export const LAUNCH_PERCENT_OFF = 30;
export const LAUNCH_MONTHS = 3;
/** The Stripe coupon behind the launch code (created by npm run stripe:setup, or on first use in test mode). */
export const LAUNCH_COUPON_ID = "multies_launch30";

/** The largest discount any code or offer may give (owner guardrail). */
export const MAX_PERCENT_OFF = 50;

/** Referral credit: one month of the referred workspace's add-ons, at least A$1 and at most A$20, to each side. */
export const REFERRAL_MIN_CENTS = 100;
export const REFERRAL_MAX_CENTS = 2000;
/** Days a first payment must stand (not refunded or disputed) before the credit is given. */
export const REFERRAL_HOLD_DAYS = 14;
/** Credits one workspace can earn by referring, in any 365 days. */
export const REFERRAL_CAP_PER_YEAR = 12;
export { REFERRAL_CODE_RE, REFERRAL_COOKIE, REFERRAL_COOKIE_DAYS, REFERRAL_PARAM } from "./referral-link";

/** One month of a monthly add-on total (A$), as a referral credit in cents within the bounds. */
export function referralCreditCents(monthlyAud: number): number {
  const cents = Math.round(monthlyAud * 100);
  return Math.min(REFERRAL_MAX_CENTS, Math.max(REFERRAL_MIN_CENTS, cents));
}

/** The plain words each page uses. No dashes, sentence case. */
export const OFFER_COPY = {
  yearly: `Pay yearly and get two months free: a year costs ${YEARLY_MONTHS_CHARGED} times the monthly price. Monthly billing stays available at A$5 a month or more; below that, add-ons bill yearly only.`,
  launch: `New subscriptions can use the code ${LAUNCH_CODE} at checkout for ${LAUNCH_PERCENT_OFF} percent off the first ${LAUNCH_MONTHS} months of monthly billing. It does not apply to yearly billing, which already includes two months free.`,
  referral: `Share your workspace's referral link from Settings, Billing. When a workspace that signed up through it makes its first payment, and that payment is not refunded within ${REFERRAL_HOLD_DAYS} days, both workspaces get a credit worth one month of the new workspace's add-ons (at least A$1, at most A$20). Each workspace can earn up to ${REFERRAL_CAP_PER_YEAR} referral credits a year, and referring your own workspace does not count.`,
} as const;
