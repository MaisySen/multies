import { toast } from "sonner";
import { ApiError } from "./api";

/**
 * Shows an API error as a toast. Plan limit errors name the add-on that lifts the limit and link to Billing, so hitting a
 * limit is one click from fixing it.
 */
export function showError(e: Error) {
  if (e instanceof ApiError && e.code === "plan_limit") {
    toast.error(e.message, { id: "plan-limit", duration: 10_000, action: { label: "See add-ons", onClick: () => window.location.assign("/app/settings/billing") } });
    return;
  }
  // R58 (MB-245): one toast however many saves the behind tab tried, with the same Reload as the banner.
  if (e instanceof ApiError && e.code === "workspace_switched") {
    toast.error(e.message, { id: "workspace-switched", duration: 10_000 });
    return;
  }
  toast.error(e.message);
}
