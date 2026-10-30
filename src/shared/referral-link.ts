/**
 * R62: what a referral link carries. Its own tiny module because the web app's entry reads it on every page load
 * (lib/referral.ts), and that must not pull in the plans and offers.
 */
/** The query parameter a referral link carries, and the cookie that keeps it until sign up. */
export const REFERRAL_PARAM = "ref";
export const REFERRAL_COOKIE = "mm_ref";
export const REFERRAL_COOKIE_DAYS = 30;
/** Referral codes: 8 characters from an alphabet without look alike letters (no I, O, 0 or 1). */
export const REFERRAL_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
