/**
 * R29: an agent trigger's History, inside the Triggers dialog. Its last 50 fires and refusals, newest first, read
 * from the audit log (GET /api/agent-triggers/:id/history): when, fired or refused and why, from a schedule, a
 * webhook or Run now, and a link to the task when a run was queued. Webhook refusals before a fire (bad signature,
 * stale, replayed, over its rate) are sampled: at most one every 10 minutes.
 */
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CircleCheck, CircleX } from "lucide-react";
import { api } from "@/web/lib/api";
import { timeAgo, zonedDateTime } from "@/web/lib/format";
import { Badge } from "@/web/components/ui/misc";
import { TRIGGER_REFUSALS } from "@/web/components/app-bits";

export interface TriggerHistoryEntry {
  id: string; at: string; outcome: "fired" | "refused"; source: "schedule" | "webhook" | "manual" | null;
  reason: string | null; message: string | null;
  run: { id: string; taskId: string | null; taskRef: string | null } | null;
  actor: { userId: string | null; email: string | null } | null;
  sampled: boolean;
}

const SOURCE_LABEL: Record<string, string> = { schedule: "Schedule", webhook: "Webhook", manual: "Run now" };

/** "Fired, queued MB-12" or "Refused: the agent is paused", for one history entry. */
export function historyLine(e: TriggerHistoryEntry): string {
  if (e.outcome === "fired") return e.run?.taskRef ? `Fired, queued a run on ${e.run.taskRef}` : "Fired, queued a run";
  const why = e.reason ? (TRIGGER_REFUSALS[e.reason] ?? e.reason.replace(/_/g, " ")) : "refused";
  return `Refused: ${why}`;
}

export function sourceLabel(e: TriggerHistoryEntry): string {
  return e.source ? (SOURCE_LABEL[e.source] ?? e.source) : "Unknown";
}

export function TriggerHistory({ triggerId }: { triggerId: string }) {
  const q = useQuery({
    queryKey: ["agent-trigger-history", triggerId],
    queryFn: () => api.get<{ entries: TriggerHistoryEntry[]; limit: number }>(`/agent-triggers/${triggerId}/history`),
    staleTime: 0,
  });
  if (q.isLoading) return <p className="px-1 py-2 text-[13px] text-muted">Loading history</p>;
  if (q.isError) return <p className="px-1 py-2 text-[13px] text-bad" role="alert">History could not be loaded.</p>;
  const entries = q.data?.entries ?? [];
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid={`trigger-history-${triggerId}`}>
      <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted">History, last {q.data?.limit ?? 50}</p>
      {!entries.length ? (
        <p className="text-[13px] text-muted">No fires or refusals yet.</p>
      ) : (
        <ol className="space-y-1.5" aria-label="Trigger history">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-[13px]" data-testid="trigger-history-entry" data-outcome={e.outcome}>
              {e.outcome === "fired"
                ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-label="Fired" />
                : <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-label="Refused" />}
              <div className="min-w-0 flex-1">
                <p className="text-fg">
                  {historyLine(e)}
                  {e.run?.taskId && (
                    <Link to={`/app/tasks?view=list&task=${e.run.taskId}`} className="ml-1.5 inline-flex items-center gap-0.5 text-brand hover:underline">
                      Open run<ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  )}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                  <span title={zonedDateTime(e.at)}>{timeAgo(e.at)}</span>
                  <Badge>{sourceLabel(e)}</Badge>
                  {e.actor?.email && <span>by {e.actor.email}</span>}
                  {e.sampled && <span title="Refusals like this are recorded at most once every 10 minutes.">sampled</span>}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
