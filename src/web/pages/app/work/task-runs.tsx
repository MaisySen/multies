/**
 * R27 (DF-3 slice 2): the Runs section of the task panel. Each run an AI agent member made on the task, newest first:
 * the agent with its Agent badge, a status chip, when it started and how long it took. A run opens to its ordered
 * steps and result. Refreshes with the task panel (its detail refetches every 20 seconds) and every 10 seconds while
 * a run is queued or running. R30: a queued or running run has a "Cancel run" button with an inline confirm; the chip
 * turns Cancelled at once and goes back if the server refuses.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, ChevronDown, ChevronRight, CircleStop, MessageSquare, RefreshCw, StickyNote, Wrench } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { fullDate, initials, timeAgo } from "@/web/lib/format";

type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
interface RunStep { at: string; kind: "note" | "tool" | "comment" | "status_change"; text: string }
export interface AgentRun {
  id: string; taskId: string; agent: { userId: string; name: string; avatarColor: string; isAgent: true };
  status: RunStatus; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  result: string | null; stepCount: number; steps: RunStep[]; createdAt: string;
}

const STATUS: Record<RunStatus, { label: string; tone: "neutral" | "ok" | "warn" | "bad" | "brand" }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "brand" },
  succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "warn" },
};
const STEP_ICON = { note: StickyNote, tool: Wrench, comment: MessageSquare, status_change: RefreshCw } as const;

/** "4 s", "3 min", "1 h 5 min". */
export function runDuration(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  if (s < 1) return "under 1 s";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** R30: the runs with one run marked cancelled (the optimistic change before the server answers). */
export function withRunCancelled<T extends { runs: AgentRun[] }>(data: T | undefined, id: string, at = new Date().toISOString()): T | undefined {
  if (!data) return data;
  return { ...data, runs: data.runs.map((r) => (r.id === id && (r.status === "queued" || r.status === "running") ? { ...r, status: "cancelled" as const, finishedAt: at } : r)) };
}

/** R30: the runs with one run replaced by the server's answer. */
export function withRun<T extends { runs: AgentRun[] }>(data: T | undefined, run: AgentRun): T | undefined {
  if (!data) return data;
  return { ...data, runs: data.runs.map((r) => (r.id === run.id ? { ...r, ...run, steps: run.steps ?? r.steps } : r)) };
}

/** Whether a run can still be cancelled (queued or running). */
export const canCancelRun = (r: Pick<AgentRun, "status">) => r.status === "queued" || r.status === "running";

export function TaskRuns({ taskId, refreshedAt }: { taskId: string; refreshedAt?: number }) {
  const qc = useQueryClient();
  const key = ["task-runs", taskId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ runs: AgentRun[] }>(`/tasks/${taskId}/runs`),
    refetchInterval: (query) => ((query.state.data as { runs: AgentRun[] } | undefined)?.runs.some((r) => r.status === "queued" || r.status === "running") ? 10_000 : false),
  });
  // Follow the task panel: when its detail refreshes, so do the runs.
  useEffect(() => { if (refreshedAt) void qc.invalidateQueries({ queryKey: key }); }, [refreshedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState<string | null>(null);
  const runs = q.data?.runs ?? [];

  const [confirming, setConfirming] = useState<string | null>(null);
  // R30: optimistic cancel with rollback.
  const cancel = useMutation({
    mutationFn: (id: string) => api.post<{ run: AgentRun }>(`/agent-runs/${id}/cancel`, {}),
    onMutate: async (id: string) => {
      setConfirming(null);
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<{ runs: AgentRun[] }>(key);
      qc.setQueryData(key, withRunCancelled(before, id));
      return { before };
    },
    onError: (e, _id, c) => { if (c?.before) qc.setQueryData(key, c.before); showError(e as Error); },
    onSuccess: (res) => { qc.setQueryData(key, (d: { runs: AgentRun[] } | undefined) => withRun(d, res.run)); toast.success("Run cancelled"); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: key }); },
  });

  if (!runs.length) return null;

  return (
    <section className="mt-6" aria-label="Runs" data-testid="task-runs">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Runs <span className="font-normal normal-case">{runs.length}</span></h3>
      <ul className="mt-2 space-y-1">
        {runs.map((r) => {
          const st = STATUS[r.status];
          const expanded = open === r.id;
          const live = canCancelRun(r);
          return (
            <li key={r.id} className="rounded-lg border border-line" data-testid="task-run">
              <button type="button" aria-expanded={expanded} aria-label={`${r.agent.name} run, ${st.label}`} onClick={() => setOpen(expanded ? null : r.id)}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-hover">
                {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" />}
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white" style={{ background: r.agent.avatarColor }} aria-hidden>{initials(r.agent.name)}</span>
                <span className="min-w-0 truncate text-[13px] font-medium">{r.agent.name}</span>
                <Badge tone="brand"><Bot className="h-3 w-3" />Agent</Badge>
                <Badge tone={st.tone} dot={r.status === "running"}>{st.label}</Badge>
                <span className="ml-auto shrink-0 text-[11.5px] text-subtle">
                  {r.startedAt ? <time dateTime={r.startedAt} title={fullDate(r.startedAt)}>{timeAgo(r.startedAt)}</time> : "Not started"}
                  {r.durationMs !== null && <span> · {runDuration(r.durationMs)}</span>}
                </span>
              </button>
              {expanded && (
                <div className="border-t border-line px-3 py-2.5">
                  {r.steps.length ? (
                    <ol className="space-y-1.5" aria-label="Steps">
                      {r.steps.map((s, i) => {
                        const Icon = STEP_ICON[s.kind] ?? StickyNote;
                        return (
                          <li key={i} className="flex gap-2 text-[12.5px]">
                            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" aria-label={s.kind.replace("_", " ")} />
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted">{s.text}</span>
                            <time className="shrink-0 text-[11px] text-subtle" dateTime={s.at} title={fullDate(s.at)}>{new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>
                          </li>
                        );
                      })}
                    </ol>
                  ) : <p className="text-[12.5px] text-subtle">No steps yet.</p>}
                  {r.result && (
                    <div className="mt-2.5 rounded-md bg-fill/70 p-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Result</p>
                      <p className="mt-1 whitespace-pre-wrap text-[13px]" data-testid="run-result">{r.result}</p>
                    </div>
                  )}
                  {live && (confirming === r.id ? (
                    <div role="group" aria-label="Cancel this run" className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2 rounded-md bg-fill/70 px-2.5 py-2" data-testid="run-cancel-confirm">
                      {/* R31: the line takes its own row on narrow panels; the two buttons stay together on one line. */}
                      <p className="min-w-[12rem] flex-1 basis-full text-[12.5px] text-muted sm:basis-0">{r.agent.name} stops and this run can't be picked up again.</p>
                      <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2" data-testid="run-cancel-buttons">
                        <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={() => setConfirming(null)}>Keep running</Button>
                        <Button size="sm" variant="danger" className="whitespace-nowrap" onClick={() => cancel.mutate(r.id)} autoFocus>Cancel run</Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="ghost" className="mt-2 hover:text-bad" onClick={() => setConfirming(r.id)} disabled={cancel.isPending && cancel.variables === r.id}>
                      <CircleStop className="h-3.5 w-3.5" aria-hidden />Cancel run
                    </Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
