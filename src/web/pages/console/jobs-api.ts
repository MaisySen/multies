/** OPS1: types, calls and plain labels for the console's Jobs section (GET/POST /api/console/jobs). */
import { api } from "@/web/lib/api";

export type JobStatus = "pending" | "running" | "done" | "dead";

export interface JobStatRow { status: JobStatus; type: string; count: number; oldestRunAt: string | null; newestUpdatedAt: string | null }
export interface JobStats { byStatus: Record<JobStatus, number>; byStatusAndType: JobStatRow[]; oldestPendingAgeMs: number; at: string }

export interface ConsoleJob {
  id: string; type: string; status: JobStatus; orgId: string | null; workspaceName: string | null;
  attempts: number; maxAttempts: number; runAt: string; lockedUntil: string | null; createdAt: string; updatedAt: string;
  lastError: string | null; payloadPreview: string;
}

export type DataMoveStatus = "running" | "stopped" | "done" | "undone" | "failed" | "ready" | "expired";
export interface ConsoleDataMove {
  id: string; orgId: string; workspaceName: string | null; kind: "import" | "export"; source: string; status: DataMoveStatus;
  total: number; done: number; error: string | null; createdByUserId: string | null;
  createdAt: string; updatedAt: string; finishedAt: string | null; lastStepAt: string | null; expiresAt: string | null;
}

export interface ReplayResult { requested: number; replayed: number }

export const jobsKeys = { stats: ["console", "jobs", "stats"] as const };

const enc = encodeURIComponent;
export const jobsApi = {
  stats: () => api.get<JobStats>("/console/jobs/stats"),
  replayOne: (id: string, reason: string) => api.post<ReplayResult>(`/console/jobs/${enc(id)}/replay`, { reason }),
  replaySelected: (ids: string[], reason: string) => api.post<ReplayResult>("/console/jobs/replay", { ids, reason }),
  replayAll: (reason: string) => api.post<ReplayResult>("/console/jobs/replay-all", { reason }),
  markDead: (id: string, reason: string) => api.post<{ id: string; status: "dead" }>(`/console/jobs/${enc(id)}/mark-dead`, { reason }),
};

/** Plain words for the queue's statuses (the internal name stays in a title attribute). */
export const JOB_STATUS_LABEL: Record<JobStatus, string> = { dead: "Failed for good", pending: "Waiting", running: "Running", done: "Done" };
export const JOB_STATUS_TONE: Record<JobStatus, "bad" | "warn" | "neutral" | "ok"> = { dead: "bad", pending: "neutral", running: "warn", done: "ok" };

export const MOVE_STATUS_LABEL: Record<DataMoveStatus, string> = {
  running: "Running", stopped: "Paused", done: "Done", undone: "Undone", failed: "Failed", ready: "Ready to download", expired: "Expired",
};
export const MOVE_STATUS_TONE: Record<DataMoveStatus, "bad" | "warn" | "neutral" | "ok"> = {
  running: "neutral", stopped: "warn", done: "ok", undone: "neutral", failed: "bad", ready: "ok", expired: "neutral",
};

/** "45 sec", "12 min", "3 h", "2 days". */
export function ageText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86_400);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

/** The oldest waiting job counts as late after 15 minutes (the runner picks up due jobs every minute). */
export const OLDEST_WAIT_WARN_MS = 15 * 60_000;
