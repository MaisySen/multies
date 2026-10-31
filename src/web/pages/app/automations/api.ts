import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import type { FlowGraph, FlowTrigger } from "@/shared/flows";

export interface FlowDto {
  id: string; name: string; description: string | null; trigger: FlowTrigger; graph: FlowGraph; enabled: boolean; runCount: number;
  lastRunAt: string | null; lastStatus: string | null; updatedAt: string; createdAt: string;
  watch: { url: string; lastCheckedAt: string | null; nextCheckAt: string | null; lastError: string | null } | null;
}
export type RunStatus = "running" | "waiting" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
export interface RunDto { id: string; flowId: string; flowName: string | null; status: RunStatus; currentNode: string | null; error: string | null; trigger: Record<string, unknown>; resumeAt: string | null; startedAt: string; finishedAt: string | null }
export interface StepDto { id: string; nodeId: string; attempt: number; kind: string; label: string; status: "running" | "succeeded" | "failed" | "waiting" | "skipped"; input: unknown; output: unknown; error: string | null; startedAt: string; finishedAt: string | null }

export const flowKeys = { all: ["flows"] as const, one: (id: string) => ["flows", id] as const, runs: (f: string) => ["flow-runs", f] as const, run: (id: string) => ["flow-run", id] as const };

export const useFlows = () => useQuery({ queryKey: flowKeys.all, retry: false, queryFn: () => api.get<{ flows: FlowDto[]; usage: { used: number; limit: number } }>("/flows") });
export const useFlow = (id: string) => useQuery({ queryKey: flowKeys.one(id), queryFn: async () => (await api.get<{ flow: FlowDto }>(`/flows/${id}`)).flow });
export const useRuns = (filters: { flowId?: string; status?: string }) => {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({ queryKey: flowKeys.runs(q), queryFn: () => api.get<{ runs: RunDto[]; more: boolean }>(`/flows/runs${q ? `?${q}` : ""}`), refetchInterval: 15_000 });
};
export const useRun = (id: string) => useQuery({ queryKey: flowKeys.run(id), queryFn: () => api.get<{ run: RunDto; graph: FlowGraph; steps: StepDto[] }>(`/flows/runs/${id}`),
  refetchInterval: (q) => (q.state.data && ["running", "waiting", "waiting_approval"].includes(q.state.data.run.status) ? 5000 : false) });

/** Pickers for step settings, loaded only when the editor opens. */
export const useChannels = () => useQuery({ queryKey: ["chat-channels-pick"], staleTime: 60_000, queryFn: async () => ((await api.get<{ channels: { id: string; name: string; isPrivate?: boolean; kind?: string }[] }>("/chat/channels")).channels ?? []).filter((c) => !c.isPrivate && c.kind !== "dm") });
export const useForms = () => useQuery({ queryKey: ["forms-pick"], staleTime: 60_000, queryFn: async () => (await api.get<{ forms: { id: string; name: string }[] }>("/forms")).forms ?? [] });
export const useEndpoints = () => useQuery({ queryKey: ["webhook-endpoints-pick"], staleTime: 60_000, retry: false, queryFn: async () => (await api.get<{ endpoints: { id: string; url: string; enabled: boolean; description: string | null }[] }>("/developer/webhooks")).endpoints ?? [] });

export const RUN_STATUS: Record<RunStatus, { label: string; tone: "ok" | "warn" | "bad" | "neutral" | "brand" }> = {
  running: { label: "Running", tone: "brand" }, waiting: { label: "Waiting", tone: "neutral" }, waiting_approval: { label: "Needs an OK", tone: "warn" },
  succeeded: { label: "Done", tone: "ok" }, failed: { label: "Failed", tone: "bad" }, cancelled: { label: "Stopped", tone: "neutral" },
};
