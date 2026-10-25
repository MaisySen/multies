import { Hono } from "hono";
import type { AppEnv } from "../context";
import { COUNTRY_CURRENCY, isCountry } from "@/shared/locale";

/**
 * An approximate local price for display only. Multies bills in Australian dollars; this turns
 * A$ into the visitor's currency with the European Central Bank's daily rates (frankfurter.dev,
 * free, no key), kept in memory for 12 hours. No database writes. When the rate can't be read the
 * answer says so and the page shows A$ alone.
 */
const TTL_MS = 12 * 3600_000;
let cache: { at: number; date: string; rates: Record<string, number> } | null = null;

export function resetFxCache() { cache = null; }

async function audRates(fetcher: typeof fetch, now: number) {
  if (cache && now - cache.at < TTL_MS) return cache;
  try {
    const r = await fetcher("https://api.frankfurter.dev/v1/latest?base=AUD", { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return cache;
    const j = await r.json() as { date?: string; rates?: Record<string, number> };
    if (!j.rates) return cache;
    cache = { at: now, date: j.date ?? "", rates: j.rates };
  } catch { /* keep the last rates, if any */ }
  return cache;
}

export function fxRoutes() {
  return new Hono<AppEnv>().get("/", async (c) => {
    const asked = (c.req.query("country") ?? c.req.header("cf-ipcountry") ?? "").toUpperCase();
    const country = isCountry(asked) ? asked : null;
    const currency = country ? COUNTRY_CURRENCY[country] ?? null : null;
    c.header("cache-control", "public, max-age=3600");
    if (!currency || currency === "AUD") return c.json({ base: "AUD", country, currency: currency ?? "AUD", rate: currency === "AUD" ? 1 : null });
    const rates = await audRates(c.var.deps.fetch, c.var.deps.now().getTime());
    const rate = rates?.rates[currency] ?? null;
    return c.json({ base: "AUD", country, currency, rate, date: rate ? rates?.date ?? null : null, source: rate ? "European Central Bank via frankfurter.dev" : null });
  });
}
