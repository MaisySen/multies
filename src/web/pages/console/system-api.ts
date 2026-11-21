/** OPS1: the System health snapshot (GET /api/console/system/snapshot) as the console reads it. */
import { api } from "@/web/lib/api";
import { consoleGet } from "@/web/lib/console-api";

export type RateScope = "auth" | "api" | "webhooks" | "app" | "handoff";
export type ComponentState = "operational" | "degraded" | "down" | "not_configured";

export interface SystemWrites {
  today: number; budget: number; level: "ok" | "warn" | "shed" | "off"; pct: number; warnAt: number; shedAt: number;
  resetAt: string; byEnvironment: Record<string, number>; at: string;
}
export interface SystemReads { today: number; budget: number; pct: number; level: string; warnAt: number; loadStopAt: number }

export interface SystemSnapshot {
  at: string;
  mode: string;
  release: string;
  migrations: { ok: true; pending: string[] } | { ok: false; error: "unreadable" };
  database: { meter: "on" | "off"; writes: SystemWrites | null; reads: SystemReads | null };
  busiestWorkspaces: { day: string; budget: number; items: { orgId: string; workspaceName: string | null; rowsWritten: number; level: "ok" | "near" | "over" | "off" }[] };
  integrations: {
    sentryApi: boolean; sentryWeb: boolean; outbound: string; billing: boolean; billingTestMode: boolean;
    auth0: boolean; google: boolean; github: boolean; mailServer: boolean; writeBudgetMeter: boolean;
  };
  circuitBreakers: { scope: "this_isolate"; providers: { provider: string; state: "closed" | "open" | "half-open" }[] };
  rateLimits: {
    store: Record<RateScope, "binding" | "database">;
    perMinute: Record<RateScope, number>;
    lockout: { maxFailures: number; windowMs: number; lockForMs: number };
  };
  uptime: { days: { date: string; checks: number; uptime: number | null; worst: ComponentState | null }[]; uptime30d: number | null; uptime90d: number | null } | null;
}

export const systemKeys = { snapshot: ["console", "system", "snapshot"] as const };

export const systemApi = {
  snapshot: () => consoleGet<SystemSnapshot>("/console/system/snapshot"),
  sentryTest: (reason: string) => api.post<{ configured: boolean; eventId: string | null }>("/console/system/sentry-test", { reason }),
};

export interface Concern { id: string; text: string; tone: "warn" | "bad" }

/** What needs attention in a snapshot, worst first. Empty means all systems normal. */
export function concerns(s: SystemSnapshot): Concern[] {
  const out: Concern[] = [];
  if (!s.migrations.ok) out.push({ id: "migrations", text: "The migration list couldn't be read", tone: "warn" });
  else if (s.migrations.pending.length) out.push({ id: "migrations", text: `${s.migrations.pending.length === 1 ? "1 database migration is" : `${s.migrations.pending.length} database migrations are`} waiting to run`, tone: "bad" });
  const w = s.database.writes;
  if (w?.level === "shed") out.push({ id: "writes", text: `Database writes are at ${w.pct}% of today's budget, saving writes`, tone: "bad" });
  else if (w?.level === "warn") out.push({ id: "writes", text: `Database writes are at ${w.pct}% of today's budget`, tone: "warn" });
  const r = s.database.reads;
  if (r && r.level !== "ok") out.push({ id: "reads", text: `Database reads are at ${r.pct}% of today's budget`, tone: r.level === "limit" ? "bad" : "warn" });
  const over = s.busiestWorkspaces.items.filter((x) => x.level === "over").length;
  if (over) out.push({ id: "workspaces", text: `${over === 1 ? "1 workspace is" : `${over} workspaces are`} over its daily write budget`, tone: "warn" });
  for (const p of s.circuitBreakers.providers) {
    if (p.state === "open") out.push({ id: `breaker-${p.provider}`, text: `${providerLabel(p.provider)} is failing, so calls to it are paused`, tone: "bad" });
    else if (p.state === "half-open") out.push({ id: `breaker-${p.provider}`, text: `${providerLabel(p.provider)} is recovering after failures`, tone: "warn" });
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
}

export function providerLabel(p: string): string {
  return p === "outbound" ? "Outbound mail" : p === "stripe" ? "Stripe" : p.charAt(0).toUpperCase() + p.slice(1);
}
