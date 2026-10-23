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
  toast.error(e.message);
}
