import { useQuery } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import { ApiError } from "@/api/errors";
import { sortRuns, orderSteps, isActive } from "./runs";
import type { AgentRun } from "@/api/types";

/** R29: agent runs, read only. Active runs refresh every 15 seconds while the screen is open. */
export const runKeys = {
  list: (status?: string) => ["runs", "list", status ?? "all"] as const,
  one: (id: string) => ["runs", "one", id] as const,
  task: (taskId: string) => ["task", taskId, "runs"] as const,
};

const POLL = 15_000;
const pollIfActive = (runs: AgentRun[] | undefined) => (runs?.some(isActive) ? POLL : false);

/** The workspace list needs the server's GET /api/agent-runs; an older server answers 404. */
export const listNotOnServer = (e: unknown) => e instanceof ApiError && e.status === 404;

export function useRuns(status?: string) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: runKeys.list(status),
    queryFn: () => cached(kv(), `meta:${mode}:runs:${status ?? "all"}`, () => api.runs({ status, limit: 50 })),
    select: (d) => sortRuns(d.runs),
    refetchInterval: (q) => pollIfActive(q.state.data?.runs),
    retry: (n, e) => !listNotOnServer(e) && n < 2,
  });
}

export function useRun(id: string) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: runKeys.one(id),
    queryFn: () => cached(kv(), `meta:${mode}:run:${id}`, () => api.run(id)),
    select: (d) => ({ ...d.run, steps: orderSteps(d.run.steps) }),
    refetchInterval: (q) => pollIfActive(q.state.data ? [q.state.data.run] : undefined),
    enabled: !!id,
  });
}

export function useTaskRuns(taskId: string) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: runKeys.task(taskId),
    queryFn: () => cached(kv(), `task:${mode}:${taskId}:runs`, () => api.taskRuns(taskId)),
    select: (d) => sortRuns(d.runs),
    refetchInterval: (q) => pollIfActive(q.state.data?.runs),
    enabled: !!taskId,
  });
}
