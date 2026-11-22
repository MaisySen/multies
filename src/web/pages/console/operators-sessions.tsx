/**
 * OPS1: the Support sessions tab of the Operators page (/console/operators?tab=sessions). Who is viewing or acting as
 * whom right now, and earlier sessions, from GET /api/console/impersonation. Roles with impersonation.act end an
 * active session with a reason (POST /api/console/impersonation/:id/end); the operator is taken out of the person's
 * account at their next action and both the console's audit log and the workspace's Activity log record it.
 */
import { useSearchParams } from "react-router";
import { IconEye } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { Empty, PersonLink, RelTime, StatusBadge, WorkspaceLink, workspaceHint } from "./components/format";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";

/** One row of GET /api/console/impersonation (services/console/impersonation.ts listImpersonations). */
export interface SupportSession {
  id: string;
  operatorUserId: string; operatorEmail: string | null; operatorName: string | null;
  targetUserId: string; targetEmail: string | null; targetName: string | null;
  orgId: string | null; orgName: string | null; orgOwnerEmail: string | null;
  mode: "view" | "act";
  reason: string;
  startedAt: string; expiresAt: string; endedAt: string | null;
  endedReason: string | null;
  active: boolean;
}

const FILTERS: FilterDef[] = [
  { key: "status", label: "Show", initial: "active", options: [
    { value: "active", label: "Active now" }, { value: "ended", label: "Ended" }, { value: "all", label: "All" },
  ] },
];

/** How a session ended, in plain words (ImpersonationEndReason on the server). */
export const END_REASON_LABELS: Record<string, string> = {
  stopped: "Stopped by the operator",
  operator_session_gone: "Stopped by the operator",
  expired: "Time limit reached",
  revoked: "Ended by an admin",
  invalid: "Operator lost access",
  signed_out: "Person signed out from Users",
};

export function endReasonLabel(s: Pick<SupportSession, "endedReason" | "active">): string | null {
  if (s.active) return null;
  // Past its limit but not yet noticed by the server: it ended on time.
  return END_REASON_LABELS[s.endedReason ?? "expired"] ?? "Ended";
}

const personName = (name: string | null, email: string | null) => name || email || "this person";

/**
 * The empty card. With a search: nothing matched it (DataTable offers to clear it). Without one, the Show filter is a
 * view, not a narrowing, so the card says what that view holds and offers no button.
 */
function emptyState(status: string, searching: boolean) {
  if (searching) return { icon: <IconEye />, title: "No sessions match", body: "Try another search." };
  if (status === "ended") return { icon: <IconEye />, title: "No ended sessions yet", body: "A View as session shows here once it ends.", action: null };
  if (status === "all") return { icon: <IconEye />, title: "No support sessions yet", body: "A session started with View as on a person's page shows here.", action: null };
  return { icon: <IconEye />, title: "Nobody is viewing as anyone right now.", body: "A session started with View as on a person's page shows here while it lasts, and under Ended afterwards.", action: null };
}

/** Names and addresses in the table stop at this width (the linked page has them in full), so the action stays in view. */
const CELL = "max-w-[9.5rem] sm:max-w-[11rem]";

export function SupportSessionsTab() {
  const canEnd = usePermission("impersonation.act");
  const [params] = useSearchParams();
  const status = params.get("status") ?? "active";
  const end = useOperatorAction<SupportSession>({
    title: "End this support session?",
    description: (s) => `${personName(s.operatorName, s.operatorEmail)} is ${s.mode === "act" ? "acting" : "viewing"} as ${personName(s.targetName, s.targetEmail)}. `
      + `The session ends now: at their next action they leave ${personName(s.targetName, s.targetEmail)}'s account and sign in again to their own. `
      + "The console's audit log and the workspace's activity log both record it, with your reason.",
    confirmLabel: "End session", tone: "danger",
    run: (s, reason) => api.post<{ ok: true }>(`/console/impersonation/${encodeURIComponent(s.id)}/end`, { reason }),
    success: "Session ended",
  });
  return (
    <div data-testid="console-operators-sessions">
      <DataTable<SupportSession>
        label="Support sessions" path="/impersonation" filters={FILTERS} search={{ placeholder: "Search people or workspace" }}
        defaultSort="startedAt:desc" rowKey={(s) => s.id} minWidth={460}
        empty={emptyState(status, !!params.get("q"))}
        columns={[
          { key: "operator", header: "Operator", secondary: true, cell: (s) => <PersonLink id={s.operatorUserId} name={s.operatorName} email={s.operatorEmail} className={CELL} /> },
          {
            key: "target", header: "Viewing as",
            cell: (s) => (
              <span className="flex flex-col">
                <PersonLink id={s.targetUserId} name={s.targetName} email={s.targetEmail} className={CELL} />
                {/* Phones hide the Operator column: who is viewing goes under the person instead. */}
                <span className={cn("truncate text-xs text-muted sm:hidden", CELL)}>By {personName(s.operatorName, s.operatorEmail)}</span>
              </span>
            ),
          },
          {
            key: "workspace", header: "Workspace", secondary: true,
            // The owner's address tells two workspaces with one name apart; not repeated when it is the person's own.
            cell: (s) => <WorkspaceLink id={s.orgId} name={s.orgName} hint={s.orgOwnerEmail && s.orgOwnerEmail === s.targetEmail ? null : workspaceHint(s.orgId, s.orgOwnerEmail)} className={CELL} />,
          },
          {
            key: "session", header: "Session", sort: "startedAt",
            cell: (s) => (
              <span className="flex flex-col items-start gap-1">
                {s.mode === "act"
                  ? <StatusBadge state="act" label="Acting" tone="warn" className="whitespace-nowrap" />
                  : <StatusBadge state="view" label="View only" tone="neutral" className="whitespace-nowrap" />}
                <span className="whitespace-nowrap text-xs text-muted">Started <RelTime at={s.startedAt} /></span>
                {s.active
                  ? <span className="whitespace-nowrap text-xs font-medium">Ends <RelTime at={s.expiresAt} /></span>
                  : (
                    <span className="text-xs text-muted">
                      Ended <RelTime at={s.endedAt ?? s.expiresAt} />
                      <span className="block text-subtle" data-testid="console-sessions-end-reason">{endReasonLabel(s)}</span>
                    </span>
                  )}
              </span>
            ),
          },
          { key: "reason", header: "Reason given", secondary: true, cell: (s) => (s.reason
            ? <span className="line-clamp-3 block min-w-[9rem] max-w-[13rem] text-muted" title={s.reason}>{s.reason}</span>
            : <Empty />) },
          { key: "actions", header: "", align: "right", cell: (s) => (canEnd && s.active
            ? <Button size="sm" variant="danger" onClick={() => end.open(s)} data-testid="console-sessions-end">End session</Button>
            : null) },
        ]}
      />
      {end.dialog}
    </div>
  );
}
