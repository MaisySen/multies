/**
 * OPS1: typed calls for the operator console (/api/console). Query keys all start with "console", so
 * invalidating ["console"] refreshes every console page after a change.
 *
 * Later areas add their own wrappers here or next to their page; lists should go through DataTable
 * (pages/console/components/data-table.tsx), which builds the query string itself from `listQuery`.
 */
import { api, ApiError } from "./api";
import type { OperatorRole, Permission } from "@/shared/operator-permissions";

/**
 * A console read: one request, no automatic retries, and the server's own message kept on any 4xx or 5xx (the app's
 * client turns a 500 into "Couldn't reach Multies. Trying again." and retries it). Use this for console GETs:
 *   useQuery({ queryKey: ["console", "thing", id], queryFn: () => consoleGet<Thing>(`/console/things/${id}`) })
 * Writes keep using `api` (through useOperatorAction).
 */
export async function consoleGet<T>(path: string): Promise<T> {
  let res: Response;
  let text: string;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 30_000) : null;
  try {
    res = await fetch(`/api${path}`, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" }, ...(ctl ? { signal: ctl.signal } : {}) });
    text = await res.text();
  } catch {
    throw new ApiError(0, "network", "Couldn't reach Multies. Check your connection, then try again.");
  } finally {
    if (timer) clearTimeout(timer);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const e = json?.error;
    const fallback = res.status >= 500 ? "Multies had a problem answering. Try again in a moment." : "Something went wrong. Try again.";
    throw new ApiError(res.status, e?.code ?? (res.status >= 500 ? "server" : "error"), e?.message || fallback, e?.details?.fields, e?.details);
  }
  return json as T;
}

/**
 * The retry rule for every ["console", ...] query (ConsoleLayout sets it as the default for that key): an answer from
 * the server (any 4xx or 5xx) shows straight away; only a request that never reached Multies is tried once more.
 */
export function consoleRetry(failures: number, err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0 && err.code === "network" && failures < 1;
  return err instanceof TypeError && failures < 1;
}

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

export interface AttentionItem { id: string; label: string; count: number; /** Shown instead of the count when set ("85%"). */ value?: string; tone: "bad" | "warn"; to: string }

/** One of the newest workspaces on the Overview. */
export interface ConsoleNewestWorkspace {
  id: string; name: string; plan: string; isDemo: boolean; createdAt: string;
  suspendedAt: string | null; pastDueSince: string | null; ownerUserId: string | null; ownerEmail: string | null;
}

export interface ConsoleOverview {
  /** What needs an operator now, most urgent first; empty when all is clear. Each `to` opens the filtered page. */
  attention: AttentionItem[];
  totals: { users: number; workspaces: number; domains: number; mailboxes: number; deliveries24h: number };
  /** The five newest workspaces. */
  newest: ConsoleNewestWorkspace[];
}

export interface PlatformAuditEntry {
  id: string; actorUserId: string | null; actorEmail: string | null; actorRole: string | null; action: string;
  targetType: string | null; targetId: string | null; orgId: string | null; reason: string | null;
  before: unknown; after: unknown; metadata: Record<string, unknown> | null;
  ip: string | null; userAgent: string | null; requestId: string | null; impersonationId: string | null; createdAt: string;
  /** The target's name (a workspace's name, a person's email, a flag's label) when the server could find it. */
  targetLabel?: string | null;
  /** The workspace's name for orgId, when it still exists. */
  orgName?: string | null;
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
  me: () => consoleGet<ConsoleMe>("/console/me"),
  overview: () => consoleGet<ConsoleOverview>("/console/overview"),
  /** Any console list: `path` is relative to /api/console, e.g. "/audit". */
  list: <T>(path: string, params: Record<string, string | null | undefined>) => consoleGet<Page<T>>(`/console${path}${listQuery(params)}`),
  /** The CSV export's address (a plain link downloads it with the session cookie). */
  auditExportUrl: (params: Record<string, string | null | undefined>) => `/api/console/audit/export${listQuery(params)}`,
  grantOperator: (body: { email: string; role: OperatorRole; reason: string }) => api.post<{ ok: true; id: string; role: OperatorRole }>("/console/operators", body),
  changeOperatorRole: (id: string, body: { role: OperatorRole; reason: string }) => api.patch<{ ok: true; role: OperatorRole }>(`/console/operators/${encodeURIComponent(id)}`, body),
  removeOperator: (id: string, body: { reason: string }) => api.del<{ ok: true }>(`/console/operators/${encodeURIComponent(id)}`, body),
};
