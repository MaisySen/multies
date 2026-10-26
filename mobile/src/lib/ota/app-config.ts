/**
 * Remote app config (GET /api/v1/app-config on the Multies server): the minimum store build that may
 * keep running, critical and rolled back update ids, check throttling and where health reports go.
 * The last good answer is kept on the phone so the rules apply offline and from the first frame.
 */
import type { KV } from "@/lib/kv";
import { DEFAULT_CONFIG, parseAppConfig, type MobileConfig } from "./policy";

const KEY = "ota:app-config";

export async function cachedAppConfig(store: KV): Promise<{ config: MobileConfig; fetchedAt: number } | null> {
  try {
    const raw = await store.get(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { json: unknown; at: number };
    return { config: parseAppConfig(v.json), fetchedAt: v.at };
  } catch { return null; }
}

export async function fetchAppConfig(o: {
  base: string;
  store: KV;
  query: Record<string, string | null | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): Promise<MobileConfig | null> {
  const f = o.fetchImpl ?? fetch;
  const qs = Object.entries(o.query).filter(([, v]) => v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`).join("&");
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs ?? 6000) : null;
  try {
    const res = await f(`${o.base}/api/v1/app-config${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json" }, signal: ctl?.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const config = parseAppConfig(json);
    try { await o.store.set(KEY, JSON.stringify({ json, at: (o.now ?? Date.now)() })); } catch { /* best effort */ }
    return config;
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

export { DEFAULT_CONFIG };
