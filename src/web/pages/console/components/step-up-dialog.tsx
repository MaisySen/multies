/**
 * OPS1: shown when the server answers 403 step_up_required (a sensitive action needs a recent sign in).
 * Usage: useOperatorAction opens it for you. On its own: <StepUpDialog open onClose={...} freshMinutes={15} />.
 * "Sign in again" signs out and comes back to this page after the new sign in; the action is then tried again by hand.
 */
import { useState } from "react";
import { useLocation } from "react-router";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { showError } from "@/web/lib/show-error";

export function StepUpDialog({ open, onClose, freshMinutes }: { open: boolean; onClose: () => void; freshMinutes?: number }) {
  const loc = useLocation();
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    try {
      const { authClient } = await import("@/web/lib/auth-client");
      await authClient.signOut();
    } catch (e) {
      // Already signed out is fine; anything else is shown, and sign in still opens.
      if (e instanceof Error && !/sign|session/i.test(e.message)) showError(e);
    }
    window.location.assign(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Sign in again to continue"
      description={`This action needs a sign in from the last ${freshMinutes ?? 15} minutes. Sign in again, then repeat the action. Nothing was changed.`}>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose}>Not now</Button>
        <Button loading={busy} onClick={() => void again()} data-testid="step-up-sign-in">Sign in again</Button>
      </div>
    </Dialog>
  );
}
