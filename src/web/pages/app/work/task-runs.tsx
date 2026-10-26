/**
 * R27 (DF-3 slice 2): the Runs section of the task panel. Each run an AI agent member made on the task, newest first:
 * the agent with its Agent badge, a status chip, when it started and how long it took. A run opens to its ordered
 * steps and result. Refreshes with the task panel (its detail refetches every 20 seconds) and every 10 seconds while
 * a run is queued or running.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronRight, MessageSquare, RefreshCw, StickyNote, Wrench } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Badge } from "@/web/components/ui/misc";
import { fullDate, initials, timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";

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
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

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
  if (!runs.length) return null;

  const cancel = async (id: string) => {
    try { await api.post(`/agent-runs/${id}/cancel`); } catch (e) { showError(e as Error); }
    await qc.invalidateQueries({ queryKey: key });
  };

  return (
    <section className="mt-6" aria-label="Runs" data-testid="task-runs">
      <h3 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Runs <span className="font-normal normal-case">{runs.length}</span></h3>
      <ul className="mt-2 space-y-1">
        {runs.map((r) => {
          const st = STATUS[r.status];
          const expanded = open === r.id;
          const live = r.status === "queued" || r.status === "running";
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
                  {live && (
                    <button type="button" onClick={() => void cancel(r.id)} className={cn("mt-2 rounded-md px-2 py-1 text-[12px] text-subtle hover:bg-hover hover:text-bad")}>Cancel run</button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
