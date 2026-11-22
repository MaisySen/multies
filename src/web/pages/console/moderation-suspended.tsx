/**
 * OPS1: the Suspended workspaces and Sign-in lockouts tabs of /console/moderation.
 * Suspended: the reason, when, and who (an operator, or "Automatic" for the spam filter), with Restore (secondary, the
 * same as on the workspace page).
 * Lockouts: accounts locked out of password sign in after too many failures, with when the lock lifts and Clear. This
 * is the console's one cross-account lockout list (a person's own lockout also shows on their Sign in tab).
 */
import { num } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { IconLock, IconShieldCheck } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { Empty, formatDateTime, PersonLink, RelTime, StatusBadge, WorkspaceLink } from "./components/format";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { CLEAR_LOCKOUT, duration, moderationApi, type Lockout, type SuspendedWorkspace } from "./moderation-api";

export function SuspendedTab() {
  const canRestore = usePermission("workspaces.suspend");
  const restore = useOperatorAction<SuspendedWorkspace>({
    title: (w) => `Restore ${w.workspaceName}?`, confirmLabel: "Restore workspace",
    description: (w) => `Sending and API access start again straight away.${w.openAbuseEvents ? ` Its ${w.openAbuseEvents === 1 ? "open abuse signal is" : `${w.openAbuseEvents} open abuse signals are`} marked as reviewed.` : ""}`,
    run: (w, reason) => moderationApi.unsuspend(w.orgId, reason),
    success: "Workspace restored",
  });
  return (
    <div data-testid="console-moderation-suspended">
      <DataTable<SuspendedWorkspace>
        label="Suspended workspaces" path="/moderation/suspended" defaultSort="suspendedAt:desc"
        rowKey={(w) => w.orgId} rowHref={(w) => `/console/workspaces/${encodeURIComponent(w.orgId)}`} minWidth={720}
        empty={{ icon: <IconShieldCheck />, title: "No suspended workspaces", body: "Workspaces suspended by an operator or the spam filter show here." }}
        columns={[
          { key: "name", header: "Workspace", sort: "name", cell: (w) => <WorkspaceLink id={w.orgId} name={w.workspaceName} className="max-w-[14rem]" /> },
          { key: "reason", header: "Reason", cell: (w) => (w.reason ? <span className="line-clamp-2 max-w-xs">{w.reason}</span> : <Empty>No reason given</Empty>) },
          { key: "when", header: "Suspended", sort: "suspendedAt", cell: (w) => <RelTime at={w.suspendedAt} className="text-muted" /> },
          { key: "by", header: "By", secondary: true, cell: (w) => (w.automatic ? <StatusBadge state="automatic" tone="warn" dot={false} label="Automatic" /> : w.suspendedBy ? (
            <PersonLink id={w.suspendedBy.userId} email={w.suspendedBy.email ?? "An operator"} />
          ) : <Empty>Not recorded</Empty>) },
          { key: "signals", header: "Open signals", align: "right", secondary: true, cell: (w) => <span className="tabular-nums">{num(w.openAbuseEvents)}</span> },
          { key: "actions", header: "", align: "right", cell: (w) => (canRestore ? <Button size="sm" variant="secondary" onClick={() => restore.open(w)} data-testid="console-moderation-restore">Restore</Button> : null) },
        ]}
      />
      {restore.dialog}
    </div>
  );
}

const LOCKOUT_FILTERS: FilterDef[] = [
  { key: "status", label: "Show", initial: "locked", options: [{ value: "locked", label: "Locked now" }, { value: "all", label: "Any recent failures", send: true }] },
];

export function LockoutsTab() {
  const canClear = usePermission(CLEAR_LOCKOUT);
  const clear = useOperatorAction<Lockout>({
    title: (l) => `Clear the lockout for ${l.email}?`, confirmLabel: "Clear lockout",
    description: "They can try their password again straight away. Their failed attempts are reset.",
    run: (l, reason) => moderationApi.clearLockout(l.email, reason),
    success: "Lockout cleared",
  });
  return (
    <div data-testid="console-moderation-lockouts">
      <DataTable<Lockout>
        label="Sign-in lockouts" path="/system/lockouts" filters={LOCKOUT_FILTERS} defaultSort="lockedUntil:desc"
        rowKey={(l) => l.email}
        empty={{ icon: <IconLock />, title: "Nobody is locked out", body: "After 10 wrong passwords in 15 minutes an account is locked for 15 minutes. Those accounts show here." }}
        columns={[
          { key: "email", header: "Account", cell: (l) => <PersonLink id={l.userId} email={l.email} className="max-w-[24rem] font-medium" /> },
          { key: "failures", header: "Failed attempts", sort: "failures", align: "right", cell: (l) => <span className="tabular-nums">{num(l.failures)}</span> },
          { key: "since", header: "Since", sort: "windowStart", secondary: true, cell: (l) => <RelTime at={l.windowStart} className="text-muted" /> },
          { key: "lifts", header: "Lock lifts in", sort: "lockedUntil", cell: (l) => (l.locked
            ? <StatusBadge state="locked" tone="bad" label={duration(l.unlocksInMs)} title={l.lockedUntil ? `Until ${formatDateTime(l.lockedUntil)}` : undefined} />
            : <StatusBadge state="unlocked" tone="neutral" label="Not locked" />) },
          { key: "actions", header: "", align: "right", cell: (l) => (canClear ? <Button size="sm" variant="secondary" onClick={() => clear.open(l)} data-testid="console-lockout-clear">Clear</Button> : null) },
        ]}
      />
      {clear.dialog}
    </div>
  );
}
