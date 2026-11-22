/**
 * R29b: remote config for the Multies mobile app, read by every phone at launch and on resume
 * (mobile/src/lib/ota). It carries:
 *   - min_supported: the oldest store build (per platform) that may keep running; older builds show a
 *     blocking "Update from the App Store / Google Play" screen;
 *   - ota.critical_update_ids: over the air updates phones apply at once (with a short notice) instead
 *     of on the next cold start; ota.blocked_update_ids: rolled back updates, so a phone still on one
 *     takes the next update at once;
 *   - check throttling and where update health reports go (the mobile Sentry DSN, public by design).
 *
 * GET /api/v1/app-config is public and cached for a minute. PUT changes the stored overrides and needs
 * the deployment's APP_CONFIG_TOKEN (the release scripts in mobile/scripts/ota.js hold it). Operators
 * read and change it in the operator console (GET/PUT /api/console/mobile, routes/console/mobile.ts).
 * Stored in app_settings under one key, so there is no migration and a change is one D1 write.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { appSettings } from "../db/schema";

export const APP_CONFIG_KEY = "mobile_app_config";

/** Built in defaults: nothing is blocked, nothing is critical. Store pages are the real listings. */
export const APP_CONFIG_DEFAULTS = {
  min_supported: { ios: { build: null as number | null, version: null as string | null }, android: { build: null as number | null, version: null as string | null } },
  store_url: {
    ios: "https://apps.apple.com/app/id6826562106",
    android: "https://play.google.com/store/apps/details?id=au.fintex.multies",
  },
  ota: { critical_update_ids: [] as string[], blocked_update_ids: [] as string[], check_interval_minutes: 30, apply_on_resume_after_minutes: 240 as number | null },
  message: null as string | null,
};

const updateId = z.string().regex(/^[0-9a-f-]{8,64}$/i, "An update id is a UUID");
const minSupported = z.object({ build: z.number().int().min(0).nullable().optional(), version: z.string().regex(/^\d+(\.\d+){0,3}$/).nullable().optional() }).strict();

/** What a PUT may change. Lists replace the stored list; `add_*`/`remove_*` edit it in place. */
export const appConfigPatch = z.object({
  min_supported: z.object({ ios: minSupported.optional(), android: minSupported.optional() }).strict().optional(),
  store_url: z.object({
    ios: z.string().regex(/^https:\/\/(apps|itunes)\.apple\.com\//).optional(),
    android: z.string().regex(/^https:\/\/play\.google\.com\//).optional(),
  }).strict().optional(),
  ota: z.object({
    critical_update_ids: z.array(updateId).max(50).optional(),
    blocked_update_ids: z.array(updateId).max(200).optional(),
    add_critical_update_ids: z.array(updateId).max(10).optional(),
    remove_critical_update_ids: z.array(updateId).max(50).optional(),
    add_blocked_update_ids: z.array(updateId).max(10).optional(),
    remove_blocked_update_ids: z.array(updateId).max(200).optional(),
    check_interval_minutes: z.number().int().min(5).max(1440).optional(),
    apply_on_resume_after_minutes: z.number().int().min(15).max(10080).nullable().optional(),
  }).strict().optional(),
  message: z.string().max(200).nullable().optional(),
}).strict();

export type AppConfigPatch = z.infer<typeof appConfigPatch>;
type Stored = Omit<AppConfigPatch, "ota"> & { ota?: Partial<typeof APP_CONFIG_DEFAULTS.ota> };

const uniq = (a: string[]) => [...new Set(a.map((x) => x.toLowerCase()))];

/** Apply a patch to the stored overrides (pure). */
export function mergePatch(stored: Stored, p: AppConfigPatch): Stored {
  const out: Stored = JSON.parse(JSON.stringify(stored ?? {}));
  if (p.min_supported) out.min_supported = { ...out.min_supported, ...Object.fromEntries(Object.entries(p.min_supported).map(([k, v]) => [k, { ...(out.min_supported as Record<string, object> | undefined)?.[k], ...v }])) };
  if (p.store_url) out.store_url = { ...out.store_url, ...p.store_url };
  if (p.message !== undefined) out.message = p.message;
  if (p.ota) {
    const o = { ...(out.ota ?? {}) };
    const list = (k: "critical_update_ids" | "blocked_update_ids", set?: string[], add?: string[], remove?: string[]) => {
      let cur = set ? uniq(set) : uniq(o[k] ?? APP_CONFIG_DEFAULTS.ota[k]);
      if (add) cur = uniq([...cur, ...add]);
      if (remove) { const r = new Set(remove.map((x) => x.toLowerCase())); cur = cur.filter((x) => !r.has(x)); }
      if (set || add || remove) o[k] = cur.slice(-200);
    };
    list("critical_update_ids", p.ota.critical_update_ids, p.ota.add_critical_update_ids, p.ota.remove_critical_update_ids);
    list("blocked_update_ids", p.ota.blocked_update_ids, p.ota.add_blocked_update_ids, p.ota.remove_blocked_update_ids);
    if (p.ota.check_interval_minutes !== undefined) o.check_interval_minutes = p.ota.check_interval_minutes;
    if (p.ota.apply_on_resume_after_minutes !== undefined) o.apply_on_resume_after_minutes = p.ota.apply_on_resume_after_minutes;
    out.ota = o;
  }
  return out;
}

/** The full answer: defaults, then the stored overrides, then the telemetry block from the deployment. */
export function resolveAppConfig(stored: Stored | null, sentryDsn: string | undefined, updatedAt: string | null) {
  const s = stored ?? {};
  const d = APP_CONFIG_DEFAULTS;
  return {
    mobile: {
      min_supported: {
        ios: { ...d.min_supported.ios, ...(s.min_supported?.ios ?? {}) },
        android: { ...d.min_supported.android, ...(s.min_supported?.android ?? {}) },
      },
      store_url: { ...d.store_url, ...(s.store_url ?? {}) },
      ota: { ...d.ota, ...(s.ota ?? {}) },
      telemetry: { sentry_dsn: sentryDsn ?? null, sample_rate: 1 },
      message: s.message ?? d.message,
    },
    updated_at: updatedAt,
  };
}

async function readStored(c: Context<AppEnv>): Promise<{ stored: Stored | null; updatedAt: string | null }> {
  const row = await c.var.deps.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, APP_CONFIG_KEY)).get();
  if (!row) return { stored: null, updatedAt: null };
  try {
    const v = JSON.parse(row.value) as { config: Stored; updated_at: string };
    return { stored: v.config ?? null, updatedAt: v.updated_at ?? null };
  } catch {
    return { stored: null, updatedAt: null };
  }
}

async function writePatch(c: Context<AppEnv>, patch: AppConfigPatch, by: string) {
  const { stored } = await readStored(c);
  const next = mergePatch(stored ?? {}, patch);
  const updatedAt = c.var.deps.now().toISOString();
  const value = JSON.stringify({ config: next, updated_at: updatedAt, updated_by: by });
  await c.var.deps.db.insert(appSettings).values({ key: APP_CONFIG_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  c.var.log?.info?.("app_config_updated", { by, keys: Object.keys(patch) });
  return resolveAppConfig(next, c.var.deps.config.mobileApp?.sentryDsn, updatedAt);
}

/** Constant time compare of two strings (lengths leak, values do not). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function parsePatch(c: Context<AppEnv>) {
  let body: unknown;
  try { body = await c.req.json(); } catch { return { error: c.json({ error: { code: "invalid_json", message: "Send a JSON body." } }, 400) }; }
  const r = appConfigPatch.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: c.json({ error: { code: "validation_failed", message: `${i?.path.join(".") || "body"}: ${i?.message ?? "invalid"}` } }, 422) };
  }
  return { patch: r.data };
}

/** Mounted at /api/v1/app-config (before the lazy v1 API). */
export function appConfigRoutes() {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const { stored, updatedAt } = await readStored(c);
      return c.json(resolveAppConfig(stored, c.var.deps.config.mobileApp?.sentryDsn, updatedAt), 200, { "cache-control": "public, max-age=60" });
    })
    .put("/", async (c) => {
      const token = c.var.deps.config.mobileApp?.configToken;
      const auth = c.req.header("authorization") ?? "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      // R30: a caller with no token is refused first (401), so a guest never sees a server error.
      if (!given) return c.json({ error: { code: "unauthorized", message: "A valid app config token is required." } }, 401);
      if (!token) return c.json({ error: { code: "not_configured", message: "APP_CONFIG_TOKEN is not set on this deployment." } }, 503);
      if (!sameSecret(given, token)) return c.json({ error: { code: "unauthorized", message: "A valid app config token is required." } }, 401);
      const p = await parsePatch(c);
      if ("error" in p) return p.error;
      return c.json(await writePatch(c, p.patch!, "token"));
    });
}
