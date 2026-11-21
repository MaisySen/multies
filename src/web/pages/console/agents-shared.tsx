/**
 * OPS1: shared bits for the Agents and AI console section: the row types the server answers
 * (routes/console/agents.ts), the calls behind its actions, and small cells (workspace link, relative time, duration).
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "@/web/lib/api";
import { fullDate, timeAgo } from "@/web/lib/format";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentRunRow {
  id: string; orgId: string; workspaceName: string | null;
  taskId: string; agentUserId: string; agentName: string | null;
  status: RunStatus; triggerId: string | null; stepCount: number;
  startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
  durationMs: number | null; longRunning: boolean;
}

export interface AgentTriggerRow {
  id: string; orgId: string; workspaceName: string | null;
  name: string; kind: "schedule" | "webhook"; enabled: boolean;
  agentUserId: string; agentName: string | null;
  nextRunAt: string | null; lastFiredAt: string | null; fireCount: number;
  createdAt: string; updatedAt: string;
}

export interface PendingApprovalRow {
  id: string; orgId: string; workspaceName: string | null;
  agentId: string; agentName: string | null; mailboxId: string;
  createdAt: string; expiresAt: string; ageMs: number; overdue: boolean;
}

export interface AiUsageRow { orgId: string; workspaceName: string | null; units: number; calls: number; days: number }
export interface AiUsagePage { items: AiUsageRow[]; nextCursor: string | null; window: { from: string; to: string }; account: { units: number; calls: number } }

export type AiKeyProblem = "key_refused" | "no_credit" | "model_unavailable";
export interface AiKeyProblemRow {
  orgId: string; workspaceName: string | null; provider: string; model: string; problem: AiKeyProblem;
  problemAt: string | null; updatedAt: string;
}

export const agentsApi = {
  cancelRun: (id: string, reason: string) => api.post<{ ok: true; status: RunStatus }>(`/console/agents/runs/${encodeURIComponent(id)}/cancel`, { reason }),
  pauseTrigger: (id: string, reason: string) => api.post<{ ok: true; enabled: boolean }>(`/console/agents/triggers/${encodeURIComponent(id)}/pause`, { reason }),
  resumeTrigger: (id: string, reason: string) => api.post<{ ok: true; enabled: boolean }>(`/console/agents/triggers/${encodeURIComponent(id)}/resume`, { reason }),
};

/** The workspace's name linking to its console page (its id when the name is gone). */
export function WorkspaceLink({ id, name }: { id: string; name: string | null }) {
  return (
    <Link to={`/console/workspaces/${encodeURIComponent(id)}`} className="font-medium text-fg hover:text-brand hover:underline">
      {name || <span className="font-mono text-xs">{id}</span>}
    </Link>
  );
}

/** "3h ago" with the exact time on hover; a dash word when there is no time. */
export function When({ at, none = "Not yet" }: { at: string | null; none?: ReactNode }) {
  if (!at) return <span className="text-subtle">{none}</span>;
  return <span className="whitespace-nowrap text-muted" title={fullDate(at)}>{timeAgo(at)}</span>;
}

/** 45s, 12m, 3h 20m, 2d 4h. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export const PROBLEM_LABELS: Record<AiKeyProblem, string> = {
  key_refused: "Key refused",
  no_credit: "Out of credit",
  model_unavailable: "Model not available",
};

export const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter", groq: "Groq", gemini: "Gemini", mistral: "Mistral",
  deepseek: "DeepSeek", custom: "Custom server",
};
