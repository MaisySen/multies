/**
 * R62: a visitor who arrives through a referral link (any page with ?ref=CODE) keeps the code in a first party
 * cookie for 30 days. The server reads it once, when the person's first sign in creates their workspace.
 */
import { REFERRAL_CODE_RE, REFERRAL_COOKIE, REFERRAL_COOKIE_DAYS, REFERRAL_PARAM } from "@/shared/referral-link";

/** The cookie string to set for a page's query string, or null when it carries no valid code. */
export function referralCookieFor(search: string, https: boolean): string | null {
  const raw = new URLSearchParams(search).get(REFERRAL_PARAM);
  const code = raw?.trim().toUpperCase();
  if (!code || !REFERRAL_CODE_RE.test(code)) return null;
  return `${REFERRAL_COOKIE}=${code}; Max-Age=${REFERRAL_COOKIE_DAYS * 86400}; Path=/; SameSite=Lax${https ? "; Secure" : ""}`;
}

export function keepReferralCode() {
  try {
    if (typeof window === "undefined") return;
    const cookie = referralCookieFor(window.location.search, window.location.protocol === "https:");
    if (cookie) document.cookie = cookie;
  } catch { /* never in the way of the page */ }
}
