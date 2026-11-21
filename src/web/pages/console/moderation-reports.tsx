/**
 * OPS1: the Reports tab of /console/moderation. The R35 queue's cards (same look and test ids), now with search, status
 * and reason filters in the address bar and Load more. Open reports first; the age turns amber from 12 hours and red
 * from 24. Every action asks for a reason (kept in the audit log and as the report's note).
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { errorMessage } from "@/web/lib/api";
import { consoleApi, consoleKeys } from "@/web/lib/console-api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, EmptyState } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { IconFlag, IconSearch, IconShieldCheck, IconWarning } from "@/web/components/ui/icon";
import { REPORT_REASONS } from "../app/work/report-sheet-r35";
import { FilterBar, useUrlParams, type FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { ageTone, moderationApi, type ConsoleReport } from "./moderation-api";

const REASON = Object.fromEntries(REPORT_REASONS.map((r) => [r.id, r.label])) as Record<string, string>;
const CONTEXT: Record<string, string> = { chat: "Channel", dm: "Direct message", meeting: "Meeting chat" };

const FILTERS: FilterDef[] = [
  { key: "status", label: "Status", initial: "open", options: [
    { value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "dismissed", label: "Dismissed" }, { value: "all", label: "Any" },
  ] },
  { key: "reason", label: "Reason", initial: "", options: [{ value: "", label: "Any" }, ...REPORT_REASONS.map((r) => ({ value: r.id, label: r.label }))] },
];

const person = (p: { id: string; name: string | null; email: string | null }) => (
  <Link to={`/console/users/${encodeURIComponent(p.id)}`} className="font-medium hover:underline">{p.name ?? "Unknown"}</Link>
);

function closedLabel(r: ConsoleReport) {
  if (r.status === "dismissed") return "Dismissed";
  return r.action === "message_removed" ? "Message removed" : r.action === "user_suspended" ? "Suspended" : "Resolved";
}

export function useReportCounts() {
  return useQuery({ queryKey: ["console", "moderation", "counts"], queryFn: moderationApi.counts, refetchInterval: 60_000 });
}

export function ReportsTab() {
  const url = useUrlParams(FILTERS, { sort: "createdAt:desc" });
  const canAct = usePermission("moderation.act");
  const canBan = usePermission("users.ban");
  const counts = useReportCounts();
  const query: Record<string, string> = { status: url.values.status || "open" };
  if (url.values.reason) query.reason = url.values.reason;
  if (url.values.q) query.q = url.values.q;
  if (url.values.sort) query.sort = url.values.sort;
  const list = useInfiniteQuery({
    queryKey: consoleKeys.list("/moderation/reports", query),
    queryFn: ({ pageParam }) => consoleApi.list<ConsoleReport>("/moderation/reports", { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!url.values.q || !!url.values.reason || (url.values.status || "open") !== "open";

  const run = (action: "dismiss" | "resolve" | "remove_message" | "suspend_user") => (r: ConsoleReport, reason: string) => moderationApi.actOnReport(r.id, { action, reason });
  const remove = useOperatorAction<ConsoleReport>({
    title: "Remove this message?", tone: "danger", confirmLabel: "Remove message",
    description: "It is deleted for everyone in the conversation, and other open reports on it are closed too.",
    run: run("remove_message"), success: "Message removed",
  });
  const suspend = useOperatorAction<ConsoleReport>({
    title: (r) => `Suspend ${r.target?.name ?? "this person"}?`, tone: "danger", confirmLabel: "Suspend user",
    description: "They are signed out everywhere and can't sign in until an operator lifts it.",
    run: run("suspend_user"), success: "Account suspended",
  });
  const resolve = useOperatorAction<ConsoleReport>({
    title: "Resolve this report?", confirmLabel: "Resolve",
    description: "Marks it as handled. Your reason is saved as the report's note.",
    run: run("resolve"), success: "Report resolved",
  });
  const dismiss = useOperatorAction<ConsoleReport>({
    title: "Dismiss this report?", confirmLabel: "Dismiss report",
    description: "Nothing happens to the person or the message. Your reason is saved as the report's note.",
    run: run("dismiss"), success: "Report dismissed",
  });

  const late = counts.data?.olderThan24h ?? 0;
  return (
    <div className="space-y-3" data-testid="console-moderation-reports">
      {late > 0 && (
        <Card className="flex items-center gap-3 border-bad/30 px-4 py-3 text-sm" data-testid="console-moderation-late">
          <IconWarning className="h-4 w-4 shrink-0 text-bad" aria-hidden />
          <span>{late === 1 ? "1 open report is" : `${late} open reports are`} more than 24 hours old. Act on these first.</span>
        </Card>
      )}
      <FilterBar filters={FILTERS} values={url.values} onChange={url.set} search={{ placeholder: "Search people, workspace or note" }} />
      {list.isPending ? (
        <SkeletonRows rows={4} label="Loading reports" />
      ) : list.error ? (
        <Card className="p-0"><EmptyState icon={<IconWarning />} title="Couldn't load reports" body={errorMessage(list.error)} action={<Button variant="secondary" onClick={() => void list.refetch()}>Try again</Button>} /></Card>
      ) : !rows.length ? (
        <Card className="p-0">
          <EmptyState icon={filtered ? <IconSearch /> : <IconShieldCheck />} title={filtered ? "No reports match" : "Nothing to review"}
            body={filtered ? "Try another search or clear the filters." : "New reports show here and are mailed to the support inbox."}
            action={filtered ? <Button variant="secondary" onClick={url.reset}>Clear search and filters</Button> : undefined} />
        </Card>
      ) : (
        <>
          <ul className="space-y-3" data-testid="moderation-queue">
            {rows.map((r) => (
              <li key={r.id}>
                <Card className="space-y-3 p-4" data-testid="moderation-report">
                  <div className="flex flex-wrap items-center gap-2">
                    <IconFlag className="h-4 w-4 text-bad" aria-hidden />
                    <span className="text-[14px] font-semibold">{REASON[r.reason] ?? r.reason}</span>
                    <Badge tone="neutral">{r.targetType === "message" ? (CONTEXT[r.context ?? "chat"] ?? "Message") : "Person"}</Badge>
                    {r.status === "open"
                      ? <Badge tone={ageTone(r.ageHours)}>{r.ageHours < 1 ? "Under an hour" : `${r.ageHours} h`}</Badge>
                      : <Badge tone="neutral">{closedLabel(r)}</Badge>}
                    <time className="ml-auto text-[12px] text-subtle" dateTime={r.createdAt} title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</time>
                  </div>
                  {r.snapshotText !== null && <blockquote className="whitespace-pre-wrap break-words rounded-lg border-l-2 border-line-strong bg-fill px-3 py-2 text-[13.5px]">{r.snapshotText || "(no text)"}</blockquote>}
                  {r.note && <p className="text-[13px] text-muted"><span className="font-medium text-fg">Reporter's note:</span> {r.note}</p>}
                  <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
                    <div className="min-w-0"><dt className="inline text-subtle">Reported: </dt><dd className="inline [overflow-wrap:anywhere]">{r.target ? <>{person(r.target)} ({r.target.email ?? "no email"}){r.target.suspended ? ", suspended" : ""}</> : "Unknown"}</dd></div>
                    <div className="min-w-0"><dt className="inline text-subtle">By: </dt><dd className="inline [overflow-wrap:anywhere]">{person(r.reporter)} ({r.reporter.email ?? "no email"})</dd></div>
                    {r.orgId && <div className="min-w-0"><dt className="inline text-subtle">Workspace: </dt><dd className="inline"><Link to={`/console/workspaces/${encodeURIComponent(r.orgId)}`} className="hover:underline">{r.workspaceName ?? r.orgId}</Link></dd></div>}
                  </dl>
                  {r.resolutionNote && <p className="text-[12.5px] text-muted">Note: {r.resolutionNote}</p>}
                  {r.status === "open" && canAct && (
                    <div className="flex flex-wrap gap-2">
                      {r.messageId && <Button size="sm" variant="danger" onClick={() => remove.open(r)} data-testid="report-remove">Remove message</Button>}
                      {canBan && r.target && !r.target.suspended && <Button size="sm" variant="danger" onClick={() => suspend.open(r)} data-testid="report-suspend">Suspend user</Button>}
                      <Button size="sm" variant="secondary" onClick={() => resolve.open(r)} data-testid="report-resolve">Resolve</Button>
                      <Button size="sm" variant="ghost" onClick={() => dismiss.open(r)} data-testid="report-dismiss">Dismiss</Button>
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3 text-xs text-subtle">
            <span className="tabular-nums">{rows.length} shown</span>
            {list.hasNextPage && <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
          </div>
        </>
      )}
      {remove.dialog}{suspend.dialog}{resolve.dialog}{dismiss.dialog}
    </div>
  );
}
