/**
 * OPS1: the Suspended workspaces and Sign-in lockouts tabs of /console/moderation.
 * Suspended: the reason, when, and who (an operator, or "Automatic" for the spam filter), with Restore.
 * Lockouts: accounts locked out of password sign in after too many failures, with when the lock lifts and Clear.
 */
import { Link } from "react-router";
import { fullDate, num, timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Badge } from "@/web/components/ui/misc";
import { IconLock, IconShieldCheck } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
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
        rowKey={(w) => w.orgId} rowHref={(w) => `/console/workspaces/${encodeURIComponent(w.orgId)}`}
        empty={{ icon: <IconShieldCheck />, title: "No suspended workspaces", body: "Workspaces suspended by an operator or the spam filter show here." }}
        columns={[
          { key: "name", header: "Workspace", sort: "name", cell: (w) => <Link to={`/console/workspaces/${encodeURIComponent(w.orgId)}`} className="font-medium hover:underline">{w.workspaceName}</Link> },
          { key: "reason", header: "Reason", cell: (w) => (w.reason ? <span className="line-clamp-2 max-w-xs">{w.reason}</span> : <span className="text-subtle">No reason given</span>) },
          { key: "when", header: "Suspended", sort: "suspendedAt", cell: (w) => <span className="whitespace-nowrap text-muted" title={fullDate(w.suspendedAt)}>{timeAgo(w.suspendedAt)}</span> },
          { key: "by", header: "By", cell: (w) => (w.automatic ? <Badge tone="warn">Automatic</Badge> : w.suspendedBy ? (
            w.suspendedBy.userId
              ? <Link to={`/console/users/${encodeURIComponent(w.suspendedBy.userId)}`} className="hover:underline">{w.suspendedBy.email ?? "An operator"}</Link>
              : <span>{w.suspendedBy.email ?? "An operator"}</span>
          ) : <span className="text-subtle">Not recorded</span>) },
          { key: "signals", header: "Open signals", align: "right", cell: (w) => <span className="tabular-nums">{num(w.openAbuseEvents)}</span> },
          { key: "actions", header: "", align: "right", cell: (w) => (canRestore ? <Button size="sm" variant="secondary" onClick={() => restore.open(w)} data-testid="console-moderation-restore">Restore</Button> : null) },
        ]}
      />
      {restore.dialog}
    </div>
  );
}

const LOCKOUT_FILTERS: FilterDef[] = [
  { key: "status", label: "Show", initial: "locked", options: [{ value: "locked", label: "Locked now" }, { value: "any", label: "Any recent failures" }] },
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
          { key: "email", header: "Account", cell: (l) => (l.userId
            ? <Link to={`/console/users/${encodeURIComponent(l.userId)}`} className="font-medium hover:underline">{l.email}</Link>
            : <span className="font-medium">{l.email}</span>) },
          { key: "failures", header: "Failed attempts", sort: "failures", align: "right", cell: (l) => <span className="tabular-nums">{num(l.failures)}</span> },
          { key: "since", header: "Since", sort: "windowStart", cell: (l) => <span className="whitespace-nowrap text-muted" title={fullDate(l.windowStart)}>{timeAgo(l.windowStart)}</span> },
          { key: "lifts", header: "Lock lifts in", sort: "lockedUntil", cell: (l) => (l.locked
            ? <span title={l.lockedUntil ? fullDate(l.lockedUntil) : undefined}><Badge tone="bad" dot>{duration(l.unlocksInMs)}</Badge></span>
            : <Badge>Not locked</Badge>) },
          { key: "actions", header: "", align: "right", cell: (l) => (canClear ? <Button size="sm" variant="secondary" onClick={() => clear.open(l)} data-testid="console-lockout-clear">Clear</Button> : null) },
        ]}
      />
      {clear.dialog}
    </div>
  );
}
