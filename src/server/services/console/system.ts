/**
 * OPS1 (operator console, "System health"): one snapshot of the platform for operators (release, pending
 * migrations, the account's D1 writes and reads against their budgets, the busiest workspaces today, which
 * integrations are configured, provider circuit breakers, the rate-limit settings and uptime history) plus the
 * current login lockouts with a clear action. Pure functions over Deps; the route layer adds the guard and audit.
 *
 * Read-only except clearLockout, which reuses services/lockout.ts. Never returns secrets: integrations are reported
 * as configured or not, never their keys or DSNs.
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Deps, RateLimitScope } from "../../context";
import { migrationDriver, pendingMigrations } from "../../db";
import { loginThrottle, organizations, usageCounters, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { clearFailures, LOCKOUT } from "../lockout";
import { breakerState, type Provider } from "../resilience";
import { uptimeHistory, type DayUptime } from "../status";
import { WORKSPACE_ROWS_METRIC, workspaceLevel, type WorkspaceBudgetLevel } from "../workspace-budget";
import { healthView, readsView, writeBudget, type WriteBudgetLevel } from "../write-budget";
import { iso, ms, pageParts, type ConsolePage, type ConsolePageResult, type SortDef } from "./jobs";

// ------------------------------------------------------------------ snapshot

export const BUSIEST_WORKSPACES = 10;
const PROVIDERS: Provider[] = ["outbound", "stripe"];
const SCOPES: RateLimitScope[] = ["auth", "api", "webhooks", "app", "handoff"];

export interface SystemSnapshot {
  at: string;
  mode: string;
  release: string;
  migrations: { ok: true; pending: string[] } | { ok: false; error: "unreadable" };
  database: {
    /** Off when the D1 analytics token is not configured (then writes and reads are null). */
    meter: "on" | "off";
    writes: { today: number; budget: number; level: WriteBudgetLevel; pct: number; warnAt: number; shedAt: number; resetAt: string; byEnvironment: Record<string, number>; at: string } | null;
    reads: { today: number; budget: number; pct: number; level: string; warnAt: number; loadStopAt: number } | null;
  };
  busiestWorkspaces: {
    day: string;
    /** The per workspace daily row budget (0 when the guard is off). */
    budget: number;
    items: { orgId: string; workspaceName: string | null; rowsWritten: number; level: WorkspaceBudgetLevel }[];
  };
  integrations: {
    sentryApi: boolean; sentryWeb: boolean; outbound: string; billing: boolean; billingTestMode: boolean;
    auth0: boolean; google: boolean; github: boolean; mailServer: boolean; writeBudgetMeter: boolean;
  };
  circuitBreakers: {
    /** Breakers live in memory: this is the state in the isolate that answered, not across the fleet. */
    scope: "this_isolate";
    providers: { provider: Provider; state: "closed" | "open" | "half-open" }[];
  };
  rateLimits: {
    /** "binding": Cloudflare rate limiting bindings count per scope; "database": the shared D1 counter (writes only). */
    store: Record<RateLimitScope, "binding" | "database">;
    perMinute: Record<RateLimitScope, number>;
    lockout: { maxFailures: number; windowMs: number; lockForMs: number };
  };
  uptime: { days: DayUptime[]; uptime30d: number | null; uptime90d: number | null } | null;
}

async function migrationsState(deps: Deps): Promise<SystemSnapshot["migrations"]> {
  try {
    const client = (deps.db as unknown as { $client: unknown }).$client;
    return { ok: true, pending: await pendingMigrations(migrationDriver(client)) };
  } catch {
    return { ok: false, error: "unreadable" };
  }
}

/**
 * Today's busiest workspaces by D1 rows written (the workspace write meter), with names. D1: usage_counters' primary
 * key is (org_id, period, metric), and an index on (period, metric) would cost a row write on every counter bump, so
 * the workspaces come from a subquery and each is one primary key probe (one row read per workspace), never a scan
 * of every counter.
 */
async function busiest(deps: Deps): Promise<SystemSnapshot["busiestWorkspaces"]> {
  const cfg = deps.config.workspaceBudget;
  const day = deps.now().toISOString().slice(0, 10);
  const rows = await deps.db.select({ orgId: usageCounters.orgId, workspaceName: organizations.name, n: usageCounters.count })
    .from(usageCounters).leftJoin(organizations, eq(organizations.id, usageCounters.orgId))
    .where(and(
      inArray(usageCounters.orgId, deps.db.select({ id: organizations.id }).from(organizations)), // D1: a subquery, no bound list
      eq(usageCounters.period, day), eq(usageCounters.metric, WORKSPACE_ROWS_METRIC),
    ))
    .orderBy(desc(usageCounters.count)).limit(BUSIEST_WORKSPACES);
  return {
    day, budget: cfg.daily,
    items: rows.map((r) => ({ orgId: r.orgId, workspaceName: r.workspaceName ?? null, rowsWritten: Number(r.n), level: workspaceLevel(Number(r.n), cfg) })),
  };
}

/** The operator's system page in one call. Each part fails on its own (null or an error marker), never the whole snapshot. */
export async function systemSnapshot(deps: Deps): Promise<SystemSnapshot> {
  const { config } = deps;
  const [migrations, wb, top, uptime] = await Promise.all([
    migrationsState(deps),
    writeBudget(deps),
    busiest(deps).catch(() => ({ day: deps.now().toISOString().slice(0, 10), budget: config.workspaceBudget.daily, items: [] })),
    uptimeHistory(deps).catch(() => null),
  ]);
  const meterOn = wb.level !== "off";
  const store = Object.fromEntries(SCOPES.map((s) => [s, deps.rateLimiters?.[s] ? "binding" : "database"])) as Record<RateLimitScope, "binding" | "database">;
  return {
    at: deps.now().toISOString(),
    mode: config.mode,
    release: config.release,
    migrations,
    database: {
      meter: meterOn ? "on" : "off",
      writes: meterOn ? healthView(wb, config.writeBudget, deps.now()) : null,
      reads: meterOn ? readsView(wb.rowsRead, config.writeBudget) : null,
    },
    busiestWorkspaces: top,
    integrations: {
      sentryApi: !!config.sentry.dsnApi, sentryWeb: !!config.sentry.dsnWeb,
      outbound: (deps.outbound as { name?: string } | undefined)?.name ?? "none",
      billing: config.billing.enabled, billingTestMode: config.billing.testMode,
      auth0: !!config.auth.auth0, google: !!config.auth.social.google, github: !!config.auth.social.github,
      mailServer: !!(config.mailServer.enabled && config.mailServer.url),
      writeBudgetMeter: !!(config.writeBudget.token && config.writeBudget.accountId),
    },
    circuitBreakers: { scope: "this_isolate", providers: PROVIDERS.map((provider) => ({ provider, state: breakerState(provider) })) },
    rateLimits: {
      store,
      perMinute: { ...RATE_LIMITS },
      lockout: { maxFailures: LOCKOUT.MAX_FAILURES, windowMs: LOCKOUT.WINDOW_MS, lockForMs: LOCKOUT.LOCK_FOR_MS },
    },
    uptime,
  };
}

// ------------------------------------------------------------------ login lockouts

export const LOCKOUT_SORT_FIELDS = ["lockedUntil", "failures", "windowStart"] as const;
export type LockoutSortField = (typeof LOCKOUT_SORT_FIELDS)[number];
const LOCKOUT_SORTS: Record<LockoutSortField, SortDef> = {
  lockedUntil: { expr: sql`coalesce(${loginThrottle.lockedUntil}, 0)`, kind: "number" },
  failures: { expr: loginThrottle.failures, kind: "number" },
  windowStart: { expr: loginThrottle.windowStart, kind: "number" },
};

export interface ConsoleLockout {
  /** The account address (login_throttle's key, lower cased). */
  email: string;
  userId: string | null;
  failures: number;
  windowStart: string;
  lockedUntil: string | null;
  locked: boolean;
  /** Until the lock lifts on its own (0 when not locked). */
  unlocksInMs: number;
}

/**
 * Accounts locked out of password sign-in now (default), or every account with recent failures (`lockedOnly: false`).
 * D1: login_throttle is keyed by email with no index on locked_until, so this scans it; pruneLockouts drops rows
 * older than a day, which keeps it small (index missing: login_throttle(locked_until)).
 */
export async function listLockouts(deps: Deps, filters: { lockedOnly?: boolean }, page: ConsolePage<LockoutSortField>): Promise<ConsolePageResult<ConsoleLockout>> {
  const p = pageParts(page, LOCKOUT_SORTS, loginThrottle.email);
  const now = deps.now();
  const lockedOnly = filters.lockedOnly ?? true;
  const rows = await deps.db.select({
    email: loginThrottle.email, failures: loginThrottle.failures, windowStart: loginThrottle.windowStart, lockedUntil: loginThrottle.lockedUntil, userId: users.id,
  }).from(loginThrottle).leftJoin(users, eq(users.email, loginThrottle.email))
    .where(and(lockedOnly ? and(isNotNull(loginThrottle.lockedUntil), gt(loginThrottle.lockedUntil, now)) : undefined, p.after))
    .orderBy(...p.orderBy).limit(p.take);
  const value = (r: (typeof rows)[number]) => (p.field === "failures" ? r.failures : p.field === "windowStart" ? ms(r.windowStart) : ms(r.lockedUntil));
  return p.finish(rows, (r) => ({ v: value(r), id: r.email }), (r) => {
    const until = r.lockedUntil ? ms(r.lockedUntil) : 0;
    const locked = until > now.getTime();
    return {
      email: r.email, userId: r.userId ?? null, failures: r.failures, windowStart: iso(r.windowStart)!, lockedUntil: iso(r.lockedUntil),
      locked, unlocksInMs: locked ? until - now.getTime() : 0,
    };
  });
}

export interface ClearLockoutResult { email: string; cleared: boolean; wasLocked: boolean; failures: number }

/** Clears an account's failed sign-in count and lock (services/lockout.ts clearFailures). 404 when there is nothing to clear. */
export async function clearLockout(deps: Deps, email: string): Promise<ClearLockoutResult> {
  const key = (email ?? "").trim().toLowerCase();
  if (!key || key.length > 320) throw new HttpError(422, "validation_failed", "Give the account's email address.");
  const row = await deps.db.select().from(loginThrottle).where(eq(loginThrottle.email, key)).get();
  if (!row) throw new HttpError(404, "not_found", "This account has no failed sign-ins to clear.");
  await clearFailures(deps.db, key);
  return { email: key, cleared: true, wasLocked: !!row.lockedUntil && row.lockedUntil.getTime() > deps.now().getTime(), failures: row.failures };
}
