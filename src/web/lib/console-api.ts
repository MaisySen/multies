/**
 * OPS1: typed calls for the operator console (/api/console). Query keys all start with "console", so
 * invalidating ["console"] refreshes every console page after a change.
 *
 * Later areas add their own wrappers here or next to their page; lists should go through DataTable
 * (pages/console/components/data-table.tsx), which builds the query string itself from `listQuery`.
 */
import { api } from "./api";
import type { OperatorRole, Permission } from "@/shared/operator-permissions";

/** Every console list answers this (services/console/listing.ts on the server). */
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface ConsoleMe {
  user: { id: string; email: string; name: string };
  role: OperatorRole;
  roleLabel: string;
  permissions: Permission[];
  twoFactor: boolean;
  loginMethod: string | null;
  signedInAt: string | null;
  freshMinutes: number;
  fresh: boolean;
  envManaged: boolean;
  environment: { mode: "production" | "development"; release: string };
}

export interface AttentionItem { id: string; label: string; count: number; tone: "bad" | "warn"; to: string }

export interface ConsoleTenant {
  id: string; name: string; plan: string; isDemo: boolean; createdAt: string; members: number; agents: number; domains: number;
  suspendedAt: string | null; suspendedReason: string | null; sendCapDaily: number | null; pastDueSince: string | null;
  meetingMinutesCap?: number | null; meetingMinutes?: number;
}

export interface ConsoleOverview {
  attention: AttentionItem[];
  totals: { users: number; workspaces: number; domains: number; mailboxes: number; deliveries24h: number };
  tenants: ConsoleTenant[];
  integrations: Record<string, boolean | string>;
}

export interface PlatformAuditEntry {
  id: string; actorUserId: string | null; actorEmail: string | null; actorRole: string | null; action: string;
  targetType: string | null; targetId: string | null; orgId: string | null; reason: string | null;
  before: unknown; after: unknown; metadata: Record<string, unknown> | null;
  ip: string | null; userAgent: string | null; requestId: string | null; impersonationId: string | null; createdAt: string;
}

export interface ConsoleOperator {
  id: string; email: string; name: string; role: OperatorRole; roleLabel: string; twoFactor: boolean;
  lastLoginMethod: string | null; lastSignInAt: string | null; envManaged: boolean; createdAt: string;
}

export const consoleKeys = {
  all: ["console"] as const,
  me: ["console", "me"] as const,
  overview: ["console", "overview"] as const,
  /** A list's key: its path and the query it was read with. */
  list: (path: string, query: Record<string, string>) => ["console", "list", path, query] as const,
};

/** "?a=1&b=2" from the set values only ("" when none). */
export function listQuery(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const consoleApi = {
  me: () => api.get<ConsoleMe>("/console/me"),
  overview: () => api.get<ConsoleOverview>("/console/overview"),
  /** Any console list: `path` is relative to /api/console, e.g. "/audit". */
  list: <T>(path: string, params: Record<string, string | null | undefined>) => api.get<Page<T>>(`/console${path}${listQuery(params)}`),
  /** The CSV export's address (a plain link downloads it with the session cookie). */
  auditExportUrl: (params: Record<string, string | null | undefined>) => `/api/console/audit/export${listQuery(params)}`,
  grantOperator: (body: { email: string; role: OperatorRole; reason: string }) => api.post<{ ok: true; id: string; role: OperatorRole }>("/console/operators", body),
  changeOperatorRole: (id: string, body: { role: OperatorRole; reason: string }) => api.patch<{ ok: true; role: OperatorRole }>(`/console/operators/${encodeURIComponent(id)}`, body),
  removeOperator: (id: string, body: { reason: string }) => api.del<{ ok: true }>(`/console/operators/${encodeURIComponent(id)}`, body),
};
