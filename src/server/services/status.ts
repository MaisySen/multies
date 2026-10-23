/**
 * Public system status: each component is probed live (with a short timeout) and the
 * result is cached for 30 seconds per instance, so the page cannot be used to hammer
 * dependencies. Only aggregate, tenant-free numbers are exposed.
 */
import { gte, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { deliveries } from "../db/schema";

export type ComponentState = "operational" | "degraded" | "down" | "not_configured";
export interface ComponentStatus { id: string; name: string; state: ComponentState; detail: string; latencyMs?: number }

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
    detail: Number(stats.inbound) ? `${Number(stats.inbound).toLocaleString("en-AU")} messages in the last 24 hours.` : "No mail received in the last 24 hours.",
  });

  if (deps.config.outbound.driver !== "resend") {
    components.push({ id: "outbound", name: "Sending mail", state: "not_configured", detail: "No sending provider is set up on this server." });
  } else {
    const probe = await timed(async () => (await deps.fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${deps.config.outbound.resendApiKey}` } })).status);
    const reachable = probe.value !== undefined && probe.value < 500;
    const outboundRate = rate(stats.outboundFailed, stats.outbound);
    components.push({
      id: "outbound", name: "Sending mail",
      state: !reachable ? "down" : outboundRate > 0.25 ? "degraded" : "operational",
      detail: !reachable ? "The sending provider is not responding." : Number(stats.outbound) ? `${Number(stats.outbound).toLocaleString("en-AU")} messages sent to other providers in the last 24 hours.` : "Ready.",
      latencyMs: probe.latencyMs,
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
  return { overall, checkedAt: deps.now().toISOString(), components };
}
