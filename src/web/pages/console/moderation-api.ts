/** OPS1: types and calls for the console's Moderation section (/api/console/moderation and the lockouts in /system). */
import { api } from "@/web/lib/api";
import type { Permission } from "@/shared/operator-permissions";

export type ReportStatus = "open" | "resolved" | "dismissed";
export type ReportActionName = "dismiss" | "resolve" | "remove_message" | "suspend_user";

export interface ConsoleReport {
  id: string;
  status: ReportStatus;
  action: "none" | "message_removed" | "user_suspended" | "warned";
  targetType: "message" | "user";
  context: "chat" | "meeting" | "dm" | null;
  reason: string;
  note: string | null;
  orgId: string | null;
  workspaceName: string | null;
  messageId: string | null;
  snapshotText: string | null;
  reporter: { id: string; name: string | null; email: string | null };
  target: { id: string; name: string | null; email: string | null; suspended: boolean } | null;
  createdAt: string;
  ageHours: number;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface ReportCounts { open: number; olderThan12h: number; olderThan24h: number; oldestAt: string | null }

export interface AbuseEvent { id: string; orgId: string; workspaceName: string; kind: string; score: number; detail: string | null; createdAt: string; resolvedAt: string | null }
export interface AbuseSummary { orgId: string; workspaceName: string; openEvents: number; topScore: number; lastEventAt: string; suspended: boolean }

export interface SuspendedWorkspace {
  orgId: string; workspaceName: string; suspendedAt: string; reason: string | null; automatic: boolean;
  suspendedBy: { userId: string | null; email: string | null } | null; openAbuseEvents: number;
}

export interface Lockout { email: string; userId: string | null; failures: number; windowStart: string; lockedUntil: string | null; locked: boolean; unlocksInMs: number }

/** The permission to clear a sign in lockout. */
export const CLEAR_LOCKOUT = "users.unlock" satisfies Permission;

const enc = encodeURIComponent;

export const moderationApi = {
  counts: () => api.get<ReportCounts>("/console/moderation/reports/counts"),
  abuseSummary: () => api.get<{ items: AbuseSummary[] }>("/console/moderation/abuse/summary"),
  actOnReport: (id: string, body: { action: ReportActionName; reason: string }) => api.post<{ ok: true }>(`/console/moderation/reports/${enc(id)}/action`, body),
  resolveAbuse: (body: { ids: string[]; reason: string } | { workspace: string; reason: string }) => api.post<{ ok: true; resolved: number }>("/console/moderation/abuse/resolve", body),
  suspend: (orgId: string, reason: string) => api.post<{ ok: true }>(`/console/moderation/workspaces/${enc(orgId)}/suspend`, { reason }),
  unsuspend: (orgId: string, reason: string) => api.post<{ ok: true; resolvedAbuseEvents: number }>(`/console/moderation/workspaces/${enc(orgId)}/unsuspend`, { reason }),
  clearLockout: (email: string, reason: string) => api.post<{ ok: true }>("/console/system/lockouts/clear", { email, reason }),
};

/** Amber from 12 hours, red from 24: reports are acted on within 24 hours. */
export function ageTone(hours: number): "ok" | "warn" | "bad" { return hours >= 24 ? "bad" : hours >= 12 ? "warn" : "ok"; }

/** "12 min", "3 h 5 min". */
export function duration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
}
