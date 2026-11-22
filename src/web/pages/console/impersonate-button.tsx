/**
 * OPS1 impersonation: "View as" on a person (and on a workspace member). Shown only to roles with impersonation.view.
 * Opens the reason dialog with a mode choice ("View only" by default; "Act as this person" only for roles with
 * impersonation.act), then POST /api/console/impersonation and a fresh load of /app as that person.
 *
 *   <ImpersonateButton userId={user.id} />                 their last used workspace
 *   <ImpersonateButton userId={m.userId} orgId={org.id} /> a given workspace they belong to
 *   <ImpersonateButton userId={user.id} size="md" />       beside a page header's other buttons (default "sm")
 */
import { useState, type ComponentProps } from "react";
import { Button } from "@/web/components/ui/button";
import { IconEye } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { usePermission } from "./guard";
import { useOperatorAction } from "./components/reason-dialog";

type ButtonSize = NonNullable<ComponentProps<typeof Button>["size"]>;

type Mode = "view" | "act";

function ModeChoice({ value, onChange, canAct }: { value: Mode; onChange: (m: Mode) => void; canAct: boolean }) {
  const option = (mode: Mode, label: string, hint: string) => (
    <label className={cn(
      "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-brand/50",
      value === mode ? "border-brand bg-brand-soft/40" : "border-line hover:bg-hover",
    )} data-testid={`console-impersonate-mode-${mode}`}>
      <input type="radio" name="impersonate-mode" checked={value === mode} onChange={() => onChange(mode)} className="mt-1 accent-brand" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="mb-1.5 text-[13px] font-medium text-fg/90">Mode</legend>
      {option("view", "View only", "See what they see. Changes are turned off.")}
      {canAct && option("act", "Act as this person", "Changes you make are made in their name and recorded with your name.")}
    </fieldset>
  );
}

export function ImpersonateButton({ userId, orgId, size = "sm" }: { userId: string; orgId?: string; size?: ButtonSize }) {
  const canView = usePermission("impersonation.view");
  const canAct = usePermission("impersonation.act");
  const [mode, setMode] = useState<Mode>("view");
  const start = useOperatorAction<void, unknown>({
    title: "View as this person?",
    description: "This opens their account in this browser for up to 30 minutes, then brings you back here. Their workspace's activity log will show that support opened it, with your reason. Passwords, sign in settings, billing, the vault and exports stay off.",
    confirmLabel: mode === "act" ? "Act as this person" : "View as this person",
    tone: mode === "act" ? "danger" : "primary",
    fields: <ModeChoice value={mode} onChange={setMode} canAct={canAct} />,
    run: (_v, reason) => api.post("/console/impersonation", { userId, ...(orgId ? { orgId } : {}), mode: canAct ? mode : "view", reason }),
    success: mode === "act" ? "Acting as this person" : "Viewing as this person",
    // The browser now carries their session: the console's own queries would only fail, so nothing is refreshed here.
    invalidate: [],
    onDone: () => window.location.assign("/app"),
  });
  if (!canView) return null;
  return (
    <>
      <Button variant="secondary" size={size} onClick={() => { setMode("view"); start.open(); }} data-testid="console-impersonate-button">
        <IconEye className="h-4 w-4" aria-hidden /> View as
      </Button>
      {start.dialog}
    </>
  );
}
