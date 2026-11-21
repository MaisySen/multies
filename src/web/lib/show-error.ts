import { toast } from "sonner";
import { ApiError } from "./api";
import { tl } from "@/web/i18n"; // R104

/** OPS1 impersonation: when the "Changes are turned off" toast last showed (at most one every 30 seconds). */
let lastImpersonationToast = 0;
export const IMPERSONATION_TOAST_MS = 30_000;

/**
 * Shows an API error as a toast. Plan limit errors name the add-on that lifts the limit and link to Billing, so hitting a
 * limit is one click from fixing it.
 */
export function showError(e: Error) {
  // OPS1 impersonation: while an operator views as someone, writes answer 403 impersonation_blocked. Say so once in a
  // while, never for the app's own background calls (polling, heartbeats), so the screen stays calm.
  if (e instanceof ApiError && e.code === "impersonation_blocked") {
    if (e.background) return;
    const now = Date.now();
    if (now - lastImpersonationToast < IMPERSONATION_TOAST_MS) return;
    lastImpersonationToast = now;
    toast.error(tl("errors", e.message), { id: "impersonation-blocked", duration: 6_000 });
    return;
  }
  if (e instanceof ApiError && e.code === "plan_limit") {
    toast.error(tl("errors", e.message), { id: "plan-limit", duration: 10_000, action: { label: "See add-ons", onClick: () => window.location.assign("/app/settings/billing") } });
    return;
  }
  // R58 (MB-245): one toast however many saves the behind tab tried, with the same Reload as the banner.
  if (e instanceof ApiError && e.code === "workspace_switched") {
    toast.error(tl("errors", e.message), { id: "workspace-switched", duration: 10_000 });
    return;
  }
  toast.error(tl("errors", e.message));
}
