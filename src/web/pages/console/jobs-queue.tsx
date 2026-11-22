/**
 * OPS1: the Queue tab of /console/jobs. Four tiles (waiting, running, failed for good, done recently) with the oldest
 * waiting age, a per type breakdown, then the job list: status (default failed for good), type and workspace filters
 * in the address bar (the workspace is picked by name, components/workspace-picker.tsx), row checkboxes for "Replay selected",
 * a Replay per row, "Mark failed for good" for waiting jobs, and "Replay all failed jobs" with the count while any have
 * failed. Every change asks for a reason and is audited. Job types read in plain words (jobTypeLabel), the raw type in
 * a title.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Skeleton, StatTile } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconCheckCircle, IconHourglass, IconPlay, IconWarning, IconWorkflow } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { consoleTable as T, DataTable, tableProps } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { Empty, JobStatusBadge, jobStatusLabel, jobTypeLabel, Labelled, LoadError, RelTime, WorkspaceLink, workspaceHint } from "./components/format";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate, usePermission } from "./guard";
import { OLDEST_WAIT_WARN_MS, ageText, jobsApi, jobsKeys, type ConsoleJob, type JobStats, type JobStatus } from "./jobs-api";
import { WorkspacePicker } from "./components/workspace-picker";
import { LOCALE } from "@/shared/locale";

const STATUS_ORDER: JobStatus[] = ["dead", "pending", "running", "done"];

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`;
}

function StatTiles({ stats }: { stats: JobStats | undefined }) {
  if (!stats) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="status" aria-busy="true" aria-label="Loading queue numbers">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}
      </div>
    );
  }
  const late = stats.oldestPendingAgeMs >= OLDEST_WAIT_WARN_MS;
  const b = stats.byStatus;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="console-jobs-stats">
      <StatTile label="Waiting" value={b.pending.toLocaleString(LOCALE)} icon={<IconHourglass />} tone={late ? "warn" : "neutral"}
        hint={<span data-testid="console-jobs-oldest" className={cn(late && "font-medium text-warn")} title="How long the oldest due job has waited">
          {b.pending ? `Oldest waiting ${ageText(stats.oldestPendingAgeMs)}` : "Nothing waiting"}
        </span>} />
      <StatTile label="Running" value={b.running.toLocaleString(LOCALE)} icon={<IconPlay />} />
      <StatTile label="Failed for good" value={b.dead.toLocaleString(LOCALE)} icon={<IconWarning />} tone={b.dead ? "bad" : "neutral"} hint="Out of retries, kept 30 days" />
      <StatTile label="Done recently" value={b.done.toLocaleString(LOCALE)} icon={<IconCheckCircle />} tone="ok" hint="Kept 7 days" />
    </div>
  );
}

/** Rows per type with a count per status; a type opens the list filtered to it. */
function TypeBreakdown({ stats, onPick }: { stats: JobStats; onPick: (type: string) => void }) {
  const rows = useMemo(() => {
    const byType = new Map<string, Record<JobStatus, number>>();
    for (const r of stats.byStatusAndType) {
      const row = byType.get(r.type) ?? { pending: 0, running: 0, done: 0, dead: 0 };
      row[r.status] += r.count;
      byType.set(r.type, row);
    }
    return [...byType].sort((a, b) => b[1].dead - a[1].dead || b[1].pending - a[1].pending || jobTypeLabel(a[0]).localeCompare(jobTypeLabel(b[0])));
  }, [stats]);
  if (!rows.length) return null;
  return (
    <section aria-labelledby="jobs-by-type">
      <h2 id="jobs-by-type" className="mb-2 text-sm font-semibold">By type</h2>
      <div className={T.wrap} tabIndex={0} role="region" aria-label="Jobs by type" data-testid="console-jobs-by-type">
        <table {...tableProps(0)}>
          <thead className={T.head}>
            <tr>
              <th className={T.th}>Type</th>
              {STATUS_ORDER.map((s) => <th key={s} className={cn(T.th, "text-right", (s === "running" || s === "done") && T.secondary)}>{jobStatusLabel(s)}</th>)}
            </tr>
          </thead>
          <tbody className={T.body}>
            {rows.map(([type, n]) => (
              <tr key={type} className={T.row}>
                <td className={T.td}>
                  <button type="button" className="text-left hover:text-brand hover:underline" onClick={() => onPick(type)} title={`${type}: show these jobs`}>{jobTypeLabel(type)}</button>
                </td>
                {STATUS_ORDER.map((s) => (
                  <td key={s} className={cn(T.td, "text-right tabular-nums", (s === "running" || s === "done") && T.secondary, s === "dead" && n.dead > 0 ? "font-medium text-bad" : n[s] ? "" : "text-subtle")}>{n[s].toLocaleString(LOCALE)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function JobsQueueTab() {
  const [params, setParams] = useSearchParams();
  const canManage = usePermission("jobs.manage");
  const status = (params.get("status") ?? "dead") as JobStatus;
  const type = params.get("type") ?? "";
  const workspace = params.get("workspace") ?? "";
  const stats = useQuery({ queryKey: jobsKeys.stats, queryFn: jobsApi.stats, refetchInterval: 30_000 });
  const deadCount = stats.data?.byStatus.dead ?? 0;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [status, type, workspace]);
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const setParam = (key: string, value: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });

  const types = useMemo(() => [...new Set((stats.data?.byStatusAndType ?? []).map((r) => r.type))], [stats.data]);
  const filters = useMemo<FilterDef[]>(() => [
    { key: "status", label: "Status", initial: "dead", options: STATUS_ORDER.map((s) => ({ value: s, label: jobStatusLabel(s) })) },
    {
      key: "type", label: "Type", initial: "",
      options: [
        { value: "", label: "Any type" },
        ...[...new Set([...types, ...(type ? [type] : [])])]
          .map((t) => ({ value: t, label: jobTypeLabel(t) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      ],
    },
  ], [types, type]);

  const replayOne = useOperatorAction<ConsoleJob>({
    title: (j) => `Replay this ${jobTypeLabel(j.type)} job?`,
    description: "It goes back to waiting with a fresh set of attempts and runs within a minute.",
    confirmLabel: "Replay job",
    run: (j, reason) => jobsApi.replayOne(j.id, reason),
    success: "Job sent back to the queue",
  });
  const replaySelected = useOperatorAction<string[]>({
    title: (ids) => `Replay ${plural(ids.length, "selected job")}?`,
    description: (ids) => `${plural(ids.length, "job")} that failed for good go back to waiting with a fresh set of attempts.`,
    confirmLabel: "Replay selected",
    run: (ids, reason) => jobsApi.replaySelected(ids, reason),
    success: (ids) => `${plural(ids.length, "job")} sent back to the queue`,
    onDone: () => setSelected(new Set()),
  });
  const replayAll = useOperatorAction<number>({
    title: "Replay all failed jobs?",
    description: (n) => `${plural(n, "job")} that failed for good will be retried, across every workspace, with a fresh set of attempts. Fix the cause first, or they fail again.`,
    confirmLabel: "Replay all", tone: "danger",
    run: (_n, reason) => jobsApi.replayAll(reason),
    success: "Failed jobs sent back to the queue",
    onDone: () => setSelected(new Set()),
  });
  const markDead = useOperatorAction<ConsoleJob>({
    title: (j) => `Stop this ${jobTypeLabel(j.type)} job?`,
    description: "It is marked as failed for good and is not retried again. You can replay it later.",
    confirmLabel: "Mark failed for good", tone: "danger",
    run: (j, reason) => jobsApi.markDead(j.id, reason),
    success: "Job marked as failed for good",
  });

  const showSelect = canManage && status === "dead";
  const actions = (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <WorkspacePicker value={workspace} onChange={(v) => setParam("workspace", v)} />
      <PermissionGate permission="jobs.manage">
        {status === "dead" && deadCount > 0 && (
          <Button size="sm" variant="secondary" disabled={!selected.size} onClick={() => replaySelected.open([...selected])} data-testid="console-jobs-replay-selected">
            Replay selected{selected.size ? ` (${selected.size})` : ""}
          </Button>
        )}
        {deadCount > 0 && (
          <Button size="sm" variant="secondary" onClick={() => replayAll.open(deadCount)} data-testid="console-jobs-replay-all"
            title={`${plural(deadCount, "job")} will be retried`}>
            Replay all failed jobs ({deadCount.toLocaleString(LOCALE)})
          </Button>
        )}
      </PermissionGate>
    </div>
  );

  return (
    <div className="space-y-6">
      {stats.error ? <LoadError error={stats.error} what="the queue numbers" retry={() => void stats.refetch()} /> : <StatTiles stats={stats.data} />}
      {stats.data && <TypeBreakdown stats={stats.data} onPick={(t) => setParam("type", t)} />}
      <section aria-labelledby="jobs-list" className="space-y-2">
        <h2 id="jobs-list" className="text-sm font-semibold">Jobs</h2>
        <DataTable<ConsoleJob>
          label="Jobs" path="/jobs" filters={filters} defaultSort="updatedAt:desc"
          params={workspace ? { workspace } : undefined}
          rowKey={(j) => j.id} actions={actions} minWidth={760}
          empty={status === "dead"
            ? { icon: <IconCheckCircle />, title: "No failed jobs", body: "Every job that ran out of retries shows here. Nothing has failed for good in the last 30 days." }
            : { icon: <IconWorkflow />, title: `No ${jobStatusLabel(status).toLowerCase()} jobs`, body: "Try another status, type or workspace." }}
          columns={[
            ...(showSelect ? [{ key: "pick", header: "", cell: (j: ConsoleJob) => (
              <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={selected.has(j.id)} onChange={() => toggle(j.id)}
                aria-label={`Select ${jobTypeLabel(j.type)} job ${j.id}`} data-testid="console-jobs-select" />
            ) }] : []),
            { key: "type", header: "Type", cell: (j) => (
              <span className="flex flex-col items-start gap-1">
                <Labelled raw={j.type} label={jobTypeLabel(j.type)} className="font-medium" />
                <JobStatusBadge status={j.status} />
              </span>
            ) },
            { key: "workspace", header: "Workspace", cell: (j) => (j.orgId
              ? <WorkspaceLink id={j.orgId} name={j.workspaceName} hint={workspaceHint(j.orgId, j.ownerEmail)} className="max-w-[12rem]" />
              : <Empty>No workspace</Empty>) },
            { key: "attempts", header: "Attempts", sort: "attempts", align: "right", cell: (j) => <span className="whitespace-nowrap tabular-nums">{j.attempts} of {j.maxAttempts}</span> },
            { key: "error", header: "Last error", cell: (j) => (j.lastError
              ? <span className="line-clamp-2 max-w-xs break-words text-xs text-muted" title={j.lastError}>{j.lastError}</span>
              : <Empty />) },
            { key: "updated", header: "Updated", sort: "updatedAt", cell: (j) => <RelTime at={j.updatedAt} className="text-muted" /> },
            { key: "payload", header: "Details", secondary: true, cell: (j) => (
              <details className="max-w-xs text-xs" data-testid="console-jobs-preview">
                <summary className="cursor-pointer whitespace-nowrap text-muted hover:text-fg">Details</summary>
                <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-fill p-2 font-mono text-[11px]">{j.payloadPreview || "Empty"}</pre>
                <p className="mt-1 text-subtle">Field names and value types only. Content is never shown.</p>
              </details>
            ) },
            { key: "actions", header: "", align: "right", cell: (j) => (
              <PermissionGate permission="jobs.manage">
                {j.status === "dead" ? (
                  <Button size="sm" variant="secondary" onClick={() => replayOne.open(j)} data-testid="console-jobs-replay">Replay</Button>
                ) : j.status === "pending" || j.status === "running" ? (
                  <Button size="sm" variant="danger" onClick={() => markDead.open(j)} data-testid="console-jobs-mark-dead">
                    Mark failed for good
                  </Button>
                ) : null}
              </PermissionGate>
            ) },
          ]}
        />
      </section>
      {replayOne.dialog}{replaySelected.dialog}{replayAll.dialog}{markDead.dialog}
    </div>
  );
}
