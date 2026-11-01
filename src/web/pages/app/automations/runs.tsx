import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconAlertCircle, IconArrowLeft, IconCheckCircle, IconCircleStop, IconClock, IconHistory, IconRefresh } from "@/web/components/ui/icon";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Select } from "@/web/components/ui/input";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { describeNode, nodeById } from "@/shared/flows";
import { flowKeys, RUN_STATUS, useFlows, useRun, useRuns, type RunDto, type StepDto } from "./api";
import { useIsAdmin } from "./hub";
import { LoadError } from "@/web/components/load-error-t1g";

const duration = (a: string, b: string | null) => {
  if (!b) return "";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms < 1000 ? "under a second" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`;
};

/** Every run of every flow, newest first, with filters. Also the Runs tab of the hub. */
export function RunsList({ flowId: fixedFlow }: { flowId?: string } = {}) {
  const [status, setStatus] = useState("");
  const [flowId, setFlowId] = useState(fixedFlow ?? "");
  const flows = useFlows();
  const q = useRuns({ flowId: fixedFlow ?? flowId, status });
  return (
    <section aria-label="Runs">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!fixedFlow && (
          <Select aria-label="Flow" value={flowId} onChange={(e) => setFlowId(e.target.value)} className="w-56 max-sm:w-full">
            <option value="">All flows</option>
            {(flows.data?.flows ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        )}
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-48 max-sm:w-full">
          <option value="">Any status</option>
          <option value="attention">Needs attention</option>
          <option value="failed">Failed</option>
          <option value="waiting_approval">Needs an OK</option>
          <option value="waiting">Waiting</option>
          <option value="succeeded">Done</option>
          <option value="cancelled">Stopped</option>
        </Select>
      </div>
      {q.isPending ? <div className="space-y-2" aria-busy="true"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        : q.isError ? <Card className="p-6"><LoadError onRetry={() => q.refetch()} /></Card>
        : !q.data.runs.length ? <Card className="p-2"><EmptyState icon={<IconHistory />} title={status || flowId ? "No runs match" : "No runs yet"} body={status || flowId ? "Try another filter." : "Each time a flow runs, it shows here with every step."} /></Card>
        : (
          <Card className="divide-y divide-line">
            {q.data.runs.map((r) => <RunRow key={r.id} run={r} showFlow={!fixedFlow} />)}
          </Card>
        )}
    </section>
  );
}

function RunRow({ run, showFlow }: { run: RunDto; showFlow: boolean }) {
  const s = RUN_STATUS[run.status];
  return (
    <Link to={`/app/automations/runs/${run.id}`} className="flex items-center gap-3 p-3.5 transition-colors duration-150 hover:bg-hover/50 focus-visible:outline-2 focus-visible:outline-brand max-sm:min-h-14">
      <StatusIcon status={run.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px]">
          <span className="truncate font-medium">{showFlow ? run.flowName ?? "Flow" : `Run ${timeAgo(run.startedAt)}`}</span>
          <Badge tone={s.tone}>{s.label}</Badge>
          {run.trigger.test === true && <Badge tone="neutral">Test</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-subtle">{showFlow && <>{timeAgo(run.startedAt)} · </>}{run.error ?? (run.finishedAt ? `Took ${duration(run.startedAt, run.finishedAt)}` : run.resumeAt ? `Carries on ${timeAgo(run.resumeAt)}` : "In progress")}</p>
      </div>
    </Link>
  );
}

function StatusIcon({ status }: { status: RunDto["status"] }) {
  const cls = "h-4 w-4 shrink-0";
  if (status === "succeeded") return <IconCheckCircle className={cn(cls, "text-ok")} aria-hidden />;
  if (status === "failed") return <IconAlertCircle className={cn(cls, "text-bad")} aria-hidden />;
  if (status === "cancelled") return <IconCircleStop className={cn(cls, "text-subtle")} aria-hidden />;
  return <IconClock className={cn(cls, status === "waiting_approval" ? "text-warn" : "text-muted")} aria-hidden />;
}

export function RunsPage() {
  return <div><PageHeader title="Automation runs" description="Every run of every flow, with each step it took." /><RunsList /></div>;
}

/** One run: each step with what went in and what came out (secrets hidden), and what can be done next. */
export function RunDetailPage() {
  const { id = "" } = useParams();
  const q = useRun(id);
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const [busy, setBusy] = useState<"" | "retry" | "stop" | "approve" | "reject">("");
  const act = async (what: "retry" | "stop" | "approve" | "reject") => {
    setBusy(what);
    try {
      if (what === "retry") await api.post(`/flows/runs/${id}/retry`, {});
      else if (what === "stop") await api.post(`/flows/runs/${id}/cancel`, {});
      else await api.post(`/flows/runs/${id}/decide`, { decision: what });
      toast.success(what === "retry" ? "Tried the failed step again" : what === "stop" ? "Run stopped" : what === "approve" ? "Approved" : "Rejected");
      await Promise.all([qc.invalidateQueries({ queryKey: flowKeys.run(id) }), qc.invalidateQueries({ queryKey: ["flow-runs"] })]);
    } catch (e) { showError(e as Error); } finally { setBusy(""); }
  };
  if (q.isPending) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-10 w-64" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;
  if (q.isError) return <Card className="p-6"><EmptyState icon={<IconHistory />} title="This run is not available" body="It may be older than 30 days, or the flow was deleted." action={<Link className="text-[13px] underline" to="/app/automations?tab=runs">Back to runs</Link>} /></Card>;
  const { run, graph, steps } = q.data;
  const s = RUN_STATUS[run.status];
  const failedNode = run.status === "failed" ? nodeById(graph, run.currentNode) : undefined;
  return (
    <div>
      <Link to="/app/automations?tab=runs" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg max-sm:min-h-11"><IconArrowLeft className="h-4 w-4" aria-hidden />All runs</Link>
      <PageHeader title={run.flowName ?? "Run"} description={<>Started {timeAgo(run.startedAt)}{run.finishedAt && `, took ${duration(run.startedAt, run.finishedAt)}`}</>}
        actions={<div className="flex flex-wrap items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <Link to={`/app/automations/flows/${run.flowId}`} className="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline">Open flow</Link>
        </div>} />
      {run.status === "failed" && (
        <Card className="mb-4 border-bad/40 bg-bad-soft/40 p-4">
          <p className="text-[14px] font-medium text-bad">{failedNode ? `${failedNode.label || describeNode(failedNode)} failed` : "The run failed"}</p>
          <p className="mt-1 text-[13px] text-fg">{run.error}</p>
          {isAdmin && <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void act("retry")} disabled={!!busy}><IconRefresh className="h-4 w-4" />{busy === "retry" ? "Trying again" : "Try again from this step"}</Button><Button size="sm" variant="ghost" onClick={() => void act("stop")} disabled={!!busy}>Stop the run</Button></div>}
        </Card>
      )}
      {run.status === "waiting_approval" && (
        <Card className="mb-4 border-warn/40 bg-warn-soft/40 p-4">
          <p className="text-[14px] font-medium">This run waits for an OK</p>
          <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void act("approve")} disabled={!!busy}>Approve</Button><Button size="sm" variant="outline" onClick={() => void act("reject")} disabled={!!busy}>Reject</Button></div>
        </Card>
      )}
      {run.status === "waiting" && isAdmin && (
        <Card className="mb-4 p-4 text-[13px]"><span>Waiting{run.resumeAt && `, carries on ${timeAgo(run.resumeAt)}`}.</span> <Button size="sm" variant="ghost" onClick={() => void act("stop")} disabled={!!busy}>Stop the run</Button></Card>
      )}
      <ol aria-label="Steps" className="relative space-y-3 border-l border-line pl-5">
        {steps.map((st) => <StepItem key={st.id} step={st} name={nodeById(graph, st.nodeId) ? (nodeById(graph, st.nodeId)!.label || describeNode(nodeById(graph, st.nodeId)!)) : st.label} />)}
      </ol>
    </div>
  );
}

const STEP_TONE: Record<StepDto["status"], { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "brand" }> = {
  running: { label: "Running", tone: "brand" }, succeeded: { label: "Done", tone: "ok" }, failed: { label: "Failed", tone: "bad" }, waiting: { label: "Waiting", tone: "warn" }, skipped: { label: "Skipped", tone: "neutral" },
};

function StepItem({ step, name }: { step: StepDto; name: string }) {
  const t = STEP_TONE[step.status];
  const out = step.output && typeof step.output === "object" ? Object.fromEntries(Object.entries(step.output as Record<string, unknown>).filter(([k]) => k !== "branch")) : step.output;
  return (
    <li className="relative">
      <span className={cn("absolute -left-[27px] top-4 h-3 w-3 rounded-full border-2 border-surface", step.status === "failed" ? "bg-bad" : step.status === "succeeded" ? "bg-ok" : step.status === "waiting" ? "bg-warn" : "bg-line-strong")} aria-hidden />
      <Card className="p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium">{name}</span>
          <Badge tone={t.tone}>{t.label}</Badge>
          {step.attempt > 1 && <Badge tone="neutral">Try {step.attempt}</Badge>}
          <span className="ml-auto text-[12px] text-subtle">{new Date(step.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}{step.finishedAt && ` · ${duration(step.startedAt, step.finishedAt)}`}</span>
        </div>
        {step.error && <p className="mt-2 text-[13px] text-bad">{step.error}</p>}
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {step.input != null && <Data label="What went in" value={step.input} />}
          {out != null && Object.keys(out as object).length > 0 && <Data label="What came out" value={out} />}
        </div>
      </Card>
    </li>
  );
}

function Data({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="group min-w-0 rounded-md border border-line bg-fill/40">
      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-fg max-sm:min-h-11 max-sm:py-3">{label}</summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2 font-mono text-[12px] text-fg">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
