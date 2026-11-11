/**
 * Public system status: each component is probed live (with a short timeout) and the
 * result is cached for 30 seconds per instance, so the page cannot be used to hammer
 * dependencies. QUAL1 (audit row 69): the public page shows states and plain words only, never how much mail the
 * platform handles; the 24 hour volume is in `volume`, which only the operators' route (/api/admin/status) returns.
 */
import { eq, gte, lt, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { appSettings, deliveries, uptimeChecks } from "../db/schema";
import { newId } from "../lib/crypto";
import { queueStats } from "./jobs";
import { breakerState } from "./resilience";

export type ComponentState = "operational" | "degraded" | "down" | "not_configured";
export interface ComponentStatus { id: string; name: string; state: ComponentState; detail: string; latencyMs?: number }

/** "1 message", "2 messages": the one plural rule for the operators' volume lines. */
export const messagesLine = (n: number) => `${n.toLocaleString("en-AU")} ${n === 1 ? "message" : "messages"}`;

/** The public status body: everything but the operators' mail volume. */
export function publicStatus<T extends { volume?: unknown }>(body: T): Omit<T, "volume"> {
  const { volume: _volume, ...rest } = body;
  return rest;
}

async function timed<T>(fn: () => Promise<T>, ms = 4000): Promise<{ value?: T; error?: unknown; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const value = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
    return { value, latencyMs: Date.now() - t0 };
  } catch (error) {
    return { error, latencyMs: Date.now() - t0 };
  }
}

let cache: { at: number; body: Awaited<ReturnType<typeof computeStatus>> } | null = null;

export async function systemStatus(deps: Deps) {
  const now = deps.now().getTime();
  if (cache && now - cache.at < 30_000) return cache.body;
  const body = await computeStatus(deps);
  cache = { at: now, body };
  return body;
}

/** For tests. */
export const resetStatusCache = () => { cache = null; };

async function computeStatus(deps: Deps) {
  const since = new Date(deps.now().getTime() - 24 * 3600_000);
  const db = await timed(async () => await deps.db.select({
    inbound: sql<number>`sum(case when ${deliveries.direction} = 'inbound' then 1 else 0 end)`,
    inboundFailed: sql<number>`sum(case when ${deliveries.direction} = 'inbound' and ${deliveries.status} in ('failed','rejected') then 1 else 0 end)`,
    outbound: sql<number>`sum(case when ${deliveries.direction} = 'outbound' and ${deliveries.provider} <> 'internal' then 1 else 0 end)`,
    outboundFailed: sql<number>`sum(case when ${deliveries.direction} = 'outbound' and ${deliveries.status} = 'failed' then 1 else 0 end)`,
  }).from(deliveries).where(gte(deliveries.createdAt, since)).get());
  const stats = db.value ?? { inbound: 0, inboundFailed: 0, outbound: 0, outboundFailed: 0 };
  const rate = (bad: number, all: number) => (Number(all) ? Number(bad) / Number(all) : 0);

  const components: ComponentStatus[] = [];
  components.push({ id: "app", name: "Web app and API", state: "operational", detail: "Responding." });
  components.push(db.error
    ? { id: "database", name: "Database", state: "down", detail: "Not reachable.", latencyMs: db.latencyMs }
    : { id: "database", name: "Database", state: db.latencyMs > 1500 ? "degraded" : "operational", detail: db.latencyMs > 1500 ? "Responding slowly." : "Responding.", latencyMs: db.latencyMs });

  const inboundRate = rate(stats.inboundFailed, stats.inbound);
  components.push({
    id: "inbound", name: "Receiving mail",
    state: inboundRate > 0.25 ? "degraded" : "operational",
    detail: inboundRate > 0.25 ? "Some incoming mail is failing. It is retried or returned to the sender." : "Receiving normally.",
  });

  // Self-hosted installs send through their own mail server (SMTP_HOST, src/entry/smtp-outbound.ts).
  const outboundName = (deps.outbound as { name?: string } | undefined)?.name ?? "";
  if (deps.config.outbound.driver !== "resend" && /smtp/.test(outboundName)) {
    components.push({ id: "outbound", name: "Sending mail", state: "operational", detail: "Sending through this server's own mail server (SMTP)." });
  } else if (deps.config.outbound.driver !== "resend") {
    components.push({ id: "outbound", name: "Sending mail", state: "not_configured", detail: "No sending provider is set up on this server." });
  } else {
    const probe = await timed(async () => (await deps.fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${deps.config.outbound.resendApiKey}` } })).status);
    const reachable = probe.value !== undefined && probe.value < 500;
    const outboundRate = rate(stats.outboundFailed, stats.outbound);
    const circuit = breakerState("outbound");
    // Mail is never lost while the provider is down: it waits in the retry queue.
    components.push({
      id: "outbound", name: "Sending mail",
      state: !reachable || circuit === "open" ? "degraded" : outboundRate > 0.25 ? "degraded" : "operational",
      detail: !reachable || circuit === "open" ? "The sending provider is not responding. Outgoing mail is queued and retried automatically." : outboundRate > 0.25 ? "Some outgoing mail is failing. It is retried automatically." : "Sending normally.",
      latencyMs: probe.latencyMs,
    });
  }

  // R74: on request work (a demo's sample data) is not background work, so it never makes the queue look stuck.
  const q = await timed(() => queueStats(deps, ["demo.seed_suite"]));
  if (q.value) {
    const backlog = q.value.oldestPendingAgeMs > 30 * 60_000;
    components.push({
      id: "queue", name: "Retries and background work", state: backlog ? "degraded" : "operational",
      detail: backlog ? "Some queued work is waiting longer than usual." : q.value.pending ? `${q.value.pending} item${q.value.pending === 1 ? "" : "s"} queued.` : "Nothing waiting.",
      latencyMs: q.latencyMs,
    });
  }

  const dns = await timed(() => deps.dns.txt("cloudflare.com"));
  components.push({
    id: "dns", name: "DNS checks", state: dns.error ? "degraded" : "operational",
    detail: dns.error ? "DNS lookups are failing, so domain checks may be stale." : "Live lookups working.", latencyMs: dns.latencyMs,
  });

  const ms = deps.config.mailServer;
  if (!ms.enabled || !ms.url) {
    components.push({ id: "mail_apps", name: "Mail apps (IMAP and SMTP)", state: "not_configured", detail: "Not offered on this server." });
  } else {
    const probe = await timed(async () => (await deps.fetch(new URL("/healthz/live", ms.url).toString())).ok);
    components.push({
      id: "mail_apps", name: "Mail apps (IMAP and SMTP)", state: probe.value ? "operational" : "down",
      detail: probe.value ? "Mail server responding." : "Mail server not responding.", latencyMs: probe.latencyMs,
    });
  }

  const live = components.filter((c) => c.state !== "not_configured");
  const overall: Exclude<ComponentState, "not_configured"> = live.some((c) => c.state === "down") ? "down" : live.some((c) => c.state === "degraded") ? "degraded" : "operational";
  const received = Number(stats.inbound) || 0, sent = Number(stats.outbound) || 0;
  return {
    overall, checkedAt: deps.now().toISOString(), components,
    /** Operators only (publicStatus drops it): the last 24 hours of mail, with failures. */
    volume: {
      received, receivedFailed: Number(stats.inboundFailed) || 0, sent, sentFailed: Number(stats.outboundFailed) || 0,
      receivedLine: received ? `${messagesLine(received)} received in the last 24 hours.` : "No mail received in the last 24 hours.",
      sentLine: sent ? `${messagesLine(sent)} sent to other providers in the last 24 hours.` : "No mail sent to other providers in the last 24 hours.",
    },
  };
}

/** Days of history the status page shows. */
export const HISTORY_DAYS = 90;

/**
 * The scheduled self check (cron, every 5 minutes in production): probes every
 * component the same way the status page does and records the result, so the page can
 * show uptime over time and not only "right now". An outside monitor (the uptime
 * workflow in GitHub Actions) watches /api/health independently of this.
 */
export async function recordUptimeCheck(deps: Deps) {
  const t0 = Date.now();
  const body = await computeStatus(deps);
  cache = { at: deps.now().getTime(), body };
  const ok = body.overall !== "down";
  await deps.db.insert(uptimeChecks).values({
    id: newId("upc"), at: deps.now(), ok, latencyMs: Date.now() - t0,
    components: JSON.stringify(Object.fromEntries(body.components.map((c) => [c.id, c.state]))),
  });
  await deps.db.delete(uptimeChecks).where(lt(uptimeChecks.at, new Date(deps.now().getTime() - (HISTORY_DAYS + 1) * 86_400_000)));
  return { ok };
}

export interface DayUptime { date: string; checks: number; uptime: number | null; worst: ComponentState | null }

/** Daily uptime for the last HISTORY_DAYS days (UTC days), oldest first. */
export async function uptimeHistory(deps: Deps): Promise<{ days: DayUptime[]; uptime30d: number | null; uptime90d: number | null }> {
  const now = deps.now().getTime();
  const since = new Date(now - HISTORY_DAYS * 86_400_000);
  const rows = (await deps.db.select({
    day: sql<string>`strftime('%Y-%m-%d', ${uptimeChecks.at} / 1000, 'unixepoch')`,
    checks: sql<number>`count(*)`,
    up: sql<number>`sum(case when ${uptimeChecks.ok} then 1 else 0 end)`,
    degraded: sql<number>`sum(case when ${uptimeChecks.components} like '%"degraded"%' then 1 else 0 end)`,
  }).from(uptimeChecks).where(gte(uptimeChecks.at, since)).groupBy(sql`1`)) as { day: string; checks: number; up: number; degraded: number }[];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: DayUptime[] = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const date = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(date);
    if (!r || !Number(r.checks)) { days.push({ date, checks: 0, uptime: null, worst: null }); continue; }
    const uptime = Number(r.up) / Number(r.checks);
    days.push({ date, checks: Number(r.checks), uptime, worst: uptime < 1 ? "down" : Number(r.degraded) ? "degraded" : "operational" });
  }
  const pct = (list: DayUptime[]) => {
    const total = list.reduce((a, d) => a + d.checks, 0);
    if (!total) return null;
    return list.reduce((a, d) => a + (d.uptime ?? 0) * d.checks, 0) / total;
  };
  return { days, uptime30d: pct(days.slice(-30)), uptime90d: pct(days) };
}

/**
 * Cross checks: each environment probes the others' /api/health on its own schedule
 * (production watches staging and the preview, staging watches production), and a
 * failure is reported to Sentry, which emails the team. One environment going down
 * is caught by another, not by itself.
 */
/** Consecutive failures before a cross check alerts; one blip during a deploy stays quiet. */
export const CROSS_CHECK_ALERT_AFTER = 2;

/**
 * Probes the other environments' health endpoints (MONITOR_URLS). Alerts once, after
 * CROSS_CHECK_ALERT_AFTER failures in a row, and logs the recovery; the per URL state
 * lives in app_settings so it survives across cron runs and isolates.
 */
/** The environment a monitored URL belongs to, so its alert is filed there and not under the checker's. */
export function monitoredEnvironment(url: string) {
  return /staging/i.test(new URL(url).hostname) ? "staging" : "production";
}

export async function crossCheck(deps: Deps): Promise<{ url: string; ok: boolean; status?: number; ms: number }[]> {
  const out: { url: string; ok: boolean; status?: number; ms: number }[] = [];
  for (const base of deps.config.monitorUrls) {
    const url = `${base.replace(/\/$/, "")}/api/health`;
    const r = await timed(async () => (await deps.fetch(url, { headers: { "user-agent": "Multies-uptime/1" } })).status, 10_000);
    const ok = r.value === 200;
    out.push({ url, ok, status: r.value, ms: r.latencyMs });
    const key = `crosscheck:${url}`;
    const prev = await deps.db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    const state = prev ? (JSON.parse(prev.value) as { fails: number; alerted: boolean }) : { fails: 0, alerted: false };
    if (ok) {
      if (state.alerted) deps.log?.info("uptime.cross_check_recovered", { url, ms: r.latencyMs });
      if (state.fails) await deps.db.delete(appSettings).where(eq(appSettings.key, key));
      continue;
    }
    state.fails += 1;
    deps.log?.warn("uptime.cross_check_failed", { url, status: r.value ?? null, ms: r.latencyMs, consecutive: state.fails });
    if (state.fails >= CROSS_CHECK_ALERT_AFTER && !state.alerted) {
      state.alerted = true;
      deps.reportError?.(new Error(`Uptime check failed: ${url} answered ${r.value ?? "nothing"} ${state.fails} times in a row`), { url, status: r.value, ms: r.latencyMs, environment: monitoredEnvironment(url) });
    }
    const value = JSON.stringify(state);
    await deps.db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  }
  return out;
}
