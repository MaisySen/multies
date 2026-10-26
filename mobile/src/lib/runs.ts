import type { AgentRun, RunStep } from "@/api/types";
import type { IconName } from "@/components/icons";

export type { AgentRun, RunStep } from "@/api/types";

type Tone = "brand" | "ok" | "warn" | "bad" | "neutral";

/** How each run status reads on a chip. An unknown status from a newer server reads as itself. */
export const RUN_STATUS: Record<string, { label: string; tone: Tone; icon: IconName }> = {
  queued: { label: "Queued", tone: "neutral", icon: "clock" },
  running: { label: "Running", tone: "brand", icon: "play" },
  succeeded: { label: "Succeeded", tone: "ok", icon: "check-circle" },
  failed: { label: "Failed", tone: "bad", icon: "alert-circle" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "x" },
};

export function runStatus(status: string): { label: string; tone: Tone; icon: IconName } {
  return RUN_STATUS[status] ?? { label: status ? status[0].toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown", tone: "neutral", icon: "info" };
}

export const isActive = (r: Pick<AgentRun, "status">) => r.status === "queued" || r.status === "running";

/** A run's length: "Under 1s", "42s", "3m 05s", "1h 20m". Null when there is nothing to show. */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 1) return "Under 1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Milliseconds the run took, or has taken so far while it runs. Null before it starts. */
export function runDurationMs(r: Pick<AgentRun, "status" | "startedAt" | "finishedAt" | "durationMs">, now = Date.now()): number | null {
  if (r.durationMs !== null && r.durationMs !== undefined) return r.durationMs;
  if (!r.startedAt) return null;
  const start = Date.parse(r.startedAt);
  const end = r.finishedAt ? Date.parse(r.finishedAt) : r.status === "running" ? now : NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** "3m 05s" for a finished run, "3m 05s so far" while it runs, "Not started" while queued. */
export function durationLabel(r: Pick<AgentRun, "status" | "startedAt" | "finishedAt" | "durationMs">, now = Date.now()): string {
  if (r.status === "queued" && !r.startedAt) return "Not started";
  const d = formatDuration(runDurationMs(r, now));
  if (!d) return r.startedAt ? "No end time" : "Not started";
  return r.status === "running" ? `${d} so far` : d;
}

/** The small line under a run: "Started 9:41 am \u00b7 3m 05s", or "Not started yet" while queued. */
export function runMeta(r: Pick<AgentRun, "status" | "startedAt" | "finishedAt" | "durationMs">, started: string | null, now = Date.now()): string {
  if (!started) return "Not started yet";
  return `Started ${started} \u00b7 ${durationLabel(r, now)}`;
}

/** Steps in the order they happened. Steps with the same time keep the order the server sent. */
export function orderSteps(steps: RunStep[] | null | undefined): RunStep[] {
  return (steps ?? []).map((s, n) => ({ s, n, t: Date.parse(s.at) }))
    .sort((a, b) => (Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? a.t - b.t : a.n - b.n))
    .map((x) => x.s);
}

export const STEP_KIND: Record<string, { label: string; icon: IconName }> = {
  note: { label: "Note", icon: "edit-3" },
  tool: { label: "Tool", icon: "zap" },
  comment: { label: "Comment", icon: "message-square" },
  status_change: { label: "Status change", icon: "arrow-right" },
};

export function stepKind(kind: string): { label: string; icon: IconName } {
  return STEP_KIND[kind] ?? { label: kind ? kind[0].toUpperCase() + kind.slice(1).replace(/_/g, " ") : "Step", icon: "info" };
}

/** Newest first, by when the run was created (the server's order; kept for runs merged on the phone). */
export function sortRuns(runs: AgentRun[]): AgentRun[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** What a screen reader says for a run row. */
export function runA11yLabel(r: AgentRun, started: string | null, now = Date.now()): string {
  return [r.agent.name, runStatus(r.status).label, r.task ? `${r.task.ref}, ${r.task.title}` : null, started ? `started ${started}` : null, durationLabel(r, now)]
    .filter(Boolean).join(", ");
}
