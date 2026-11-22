/**
 * OPS1: the Abuse signals tab of /console/moderation. First the workspaces with open signals (highest score first), each
 * with Dismiss signals and Suspend workspace, then every signal with filters, Load more and a Dismiss per signal.
 */
import { useQuery } from "@tanstack/react-query";
import { num } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Skeleton } from "@/web/components/ui/misc";
import { IconShieldCheck } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { consoleTable as T, DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { EmptyRow, humanize, LoadError, RelTime, StatusBadge, WorkspaceLink, workspaceHint } from "./components/format";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { moderationApi, type AbuseEvent, type AbuseSummary } from "./moderation-api";

const FILTERS: FilterDef[] = [
  { key: "status", label: "Status", initial: "open", options: [{ value: "open", label: "Open" }, { value: "resolved", label: "Dismissed" }, { value: "all", label: "Any", send: true }] },
];

function Summary() {
  const canAct = usePermission("moderation.act");
  const canSuspend = usePermission("workspaces.suspend");
  const q = useQuery({ queryKey: ["console", "moderation", "abuse-summary"], queryFn: moderationApi.abuseSummary });
  const dismissAll = useOperatorAction<AbuseSummary>({
    title: (w) => `Dismiss ${w.openEvents === 1 ? "the open signal" : `all ${w.openEvents} open signals`} for ${w.workspaceName}?`,
    description: "They are marked as reviewed. New signals still show here.",
    confirmLabel: "Dismiss signals",
    run: (w, reason) => moderationApi.resolveAbuse({ workspace: w.orgId, reason }),
    success: "Signals dismissed",
  });
  const suspend = useOperatorAction<AbuseSummary>({
    title: (w) => `Suspend ${w.workspaceName}?`, tone: "danger", confirmLabel: "Suspend workspace",
    description: "Sending and API access stop straight away. Mail still arrives. The workspace sees your reason.",
    run: (w, reason) => moderationApi.suspend(w.orgId, reason),
    success: "Workspace suspended",
  });
  if (q.isPending) return <Skeleton className="h-32 rounded-xl" />;
  if (q.error) return <LoadError error={q.error} what="the workspace summary" retry={() => void q.refetch()} />;
  const items = q.data.items;
  return (
    <section aria-labelledby="abuse-summary-h" className="space-y-2">
      <h2 id="abuse-summary-h" className="text-[15px] font-semibold">Workspaces with open signals</h2>
      {!items.length ? (
        <EmptyRow icon={<IconShieldCheck />}>No open signals. The spam filter raises one when a workspace's sending looks wrong.</EmptyRow>
      ) : (
        <div className={T.wrap} tabIndex={0} role="region" aria-label="Workspaces with open signals" data-testid="console-abuse-summary">
          <table className={T.table}>
            <thead className={T.head}><tr>
              <th className={T.th}>Workspace</th><th className={cn(T.th, "text-right")}>Open signals</th><th className={cn(T.th, "text-right", T.secondary)}>Top score</th>
              <th className={cn(T.th, T.secondary)}>Last signal</th><th className={T.th}><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody className={T.body}>
              {items.map((w) => (
                <tr key={w.orgId} className={T.row}>
                  <td className={T.td}><span className="flex flex-wrap items-center gap-1.5"><WorkspaceLink id={w.orgId} name={w.workspaceName} hint={workspaceHint(w.orgId, w.ownerEmail)} className="max-w-[14rem]" />{w.suspended && <StatusBadge state="suspended" label="Suspended" />}</span></td>
                  <td className={cn(T.td, "text-right tabular-nums")}>{num(w.openEvents)}</td>
                  <td className={cn(T.td, "text-right tabular-nums", T.secondary)}>{num(w.topScore)}</td>
                  <td className={cn(T.td, "text-muted", T.secondary)}><RelTime at={w.lastEventAt} /></td>
                  <td className={cn(T.td, "text-right")}>
                    <span className="inline-flex gap-1.5">
                      {canAct && <Button size="sm" variant="secondary" onClick={() => dismissAll.open(w)} data-testid="console-abuse-dismiss-workspace">Dismiss signals</Button>}
                      {canSuspend && !w.suspended && <Button size="sm" variant="danger" onClick={() => suspend.open(w)} data-testid="console-abuse-suspend">Suspend workspace</Button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dismissAll.dialog}{suspend.dialog}
    </section>
  );
}

export function AbuseTab() {
  const canAct = usePermission("moderation.act");
  const dismiss = useOperatorAction<AbuseEvent>({
    title: "Dismiss this signal?", confirmLabel: "Dismiss signal",
    description: (e) => `${humanize(e.kind)} for ${e.workspaceName} is marked as reviewed.`,
    run: (e, reason) => moderationApi.resolveAbuse({ ids: [e.id], reason }),
    success: "Signal dismissed",
  });
  return (
    <div className="space-y-6" data-testid="console-moderation-abuse">
      <Summary />
      <section aria-labelledby="abuse-events-h" className="space-y-2">
        <h2 id="abuse-events-h" className="text-[15px] font-semibold">Signals</h2>
        <DataTable<AbuseEvent>
          label="Abuse signals" path="/moderation/abuse" filters={FILTERS} defaultSort="createdAt:desc"
          rowKey={(e) => e.id} minWidth={680}
          empty={{ icon: <IconShieldCheck />, title: "No signals here", body: "Change the status filter to see dismissed signals." }}
          columns={[
            { key: "ws", header: "Workspace", cell: (e) => <WorkspaceLink id={e.orgId} name={e.workspaceName} hint={workspaceHint(e.orgId, e.ownerEmail)} className="max-w-[14rem]" /> },
            { key: "kind", header: "Signal", cell: (e) => <span className="flex flex-col"><span title={e.kind}>{humanize(e.kind)}</span>{e.detail && <span className="line-clamp-2 max-w-xs text-xs text-subtle">{e.detail}</span>}</span> },
            { key: "score", header: "Score", sort: "score", align: "right", cell: (e) => <span className="tabular-nums">{num(e.score)}</span> },
            { key: "when", header: "When", sort: "createdAt", cell: (e) => <RelTime at={e.createdAt} className="text-muted" /> },
            { key: "status", header: "Status", secondary: true, cell: (e) => (e.resolvedAt ? <StatusBadge state="dismissed" label="Dismissed" /> : <StatusBadge state="open" label="Open" />) },
            { key: "actions", header: "", align: "right", cell: (e) => (canAct && !e.resolvedAt ? <Button size="sm" variant="secondary" onClick={() => dismiss.open(e)} data-testid="console-abuse-dismiss">Dismiss</Button> : null) },
          ]}
        />
      </section>
      {dismiss.dialog}
    </div>
  );
}
