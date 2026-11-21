/**
 * OPS1: the console's "Mobile app config" section, over the R29b remote config (routes/app-config-r29b.ts).
 *
 * Validation, merging and the effective values all come from that module (appConfigPatch, mergePatch,
 * resolveAppConfig); this file only reads and writes the same app_settings row in the same shape
 * ({ config, updated_at, updated_by }), so GET /api/v1/app-config, /api/admin/app-config and the console agree.
 * updateMobileConfig returns { before, after } for the platform audit row.
 */
import { eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { appSettings } from "../../db/schema";
import { zodToHttp } from "../../lib/errors";
import { APP_CONFIG_KEY, appConfigPatch, mergePatch, resolveAppConfig, type AppConfigPatch } from "../../routes/app-config-r29b";

type StoredConfig = Parameters<typeof mergePatch>[0];
export type EffectiveMobileConfig = ReturnType<typeof resolveAppConfig>["mobile"];

export interface MobileConfigActor { userId: string; email?: string | null }

/** One field of the console form. `path` is the dotted key in the PUT body (appConfigPatch). */
export interface MobileConfigField {
  path: string;
  label: string;
  help: string;
  type: "integer" | "version" | "url" | "update_ids" | "text";
  nullable: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
}

export const MOBILE_CONFIG_FIELDS: readonly MobileConfigField[] = [
  { path: "min_supported.ios.build", label: "Oldest iPhone build allowed", help: "Phones on an older store build must update from the App Store before they can continue. Empty allows every build.", type: "integer", nullable: true, min: 0 },
  { path: "min_supported.ios.version", label: "Oldest iPhone version allowed", help: "The same rule by version number, for example 1.4.0. Empty allows every version.", type: "version", nullable: true },
  { path: "min_supported.android.build", label: "Oldest Android build allowed", help: "Phones on an older store build must update from Google Play before they can continue. Empty allows every build.", type: "integer", nullable: true, min: 0 },
  { path: "min_supported.android.version", label: "Oldest Android version allowed", help: "The same rule by version number, for example 1.4.0. Empty allows every version.", type: "version", nullable: true },
  { path: "store_url.ios", label: "App Store page", help: "Where the update screen sends iPhone users. Must be an apps.apple.com address.", type: "url", nullable: false },
  { path: "store_url.android", label: "Google Play page", help: "Where the update screen sends Android users. Must be a play.google.com address.", type: "url", nullable: false },
  { path: "ota.critical_update_ids", label: "Critical updates", help: "Over the air updates phones apply at once, with a short notice, instead of on the next start. For example, a fix for a crash at sign in that every phone should get now: paste its update id here.", type: "update_ids", nullable: false, max: 50 },
  { path: "ota.blocked_update_ids", label: "Rolled back updates", help: "Updates that were pulled. A phone still running one takes the next update at once.", type: "update_ids", nullable: false, max: 200 },
  { path: "ota.check_interval_minutes", label: "Check for updates every (minutes)", help: "How often a running app asks for a new update. Between 5 and 1440.", type: "integer", nullable: false, min: 5, max: 1440 },
  { path: "ota.apply_on_resume_after_minutes", label: "Apply on resume after (minutes)", help: "An app left in the background this long applies a waiting update when it comes back. Empty turns this off.", type: "integer", nullable: true, min: 15, max: 10080 },
  { path: "message", label: "Message on the update screen", help: "Optional extra line shown on the update screen. Up to 200 characters.", type: "text", nullable: true, maxLength: 200 },
];

/** What the console shows: the stored overrides, the values phones get, and who changed them last. */
export interface MobileConfigState {
  stored: StoredConfig;
  effective: EffectiveMobileConfig;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface MobileConfigView extends MobileConfigState { fields: readonly MobileConfigField[] }

async function readState(deps: Pick<Deps, "db" | "config">): Promise<MobileConfigState> {
  const row = await deps.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, APP_CONFIG_KEY)).get();
  let stored: StoredConfig = {};
  let updatedAt: string | null = null;
  let updatedBy: string | null = null;
  if (row) {
    try {
      const v = JSON.parse(row.value) as { config?: StoredConfig; updated_at?: string; updated_by?: string };
      stored = v.config ?? {};
      updatedAt = v.updated_at ?? null;
      updatedBy = v.updated_by ?? null;
    } catch { /* a broken row reads as defaults, as GET /api/v1/app-config does */ }
  }
  return { stored, effective: resolveAppConfig(stored, deps.config.mobileApp?.sentryDsn, updatedAt).mobile, updatedAt, updatedBy };
}

/** The form: stored values, effective values and field metadata. Reads one row; writes nothing. */
export async function getMobileConfig(deps: Pick<Deps, "db" | "config">): Promise<MobileConfigView> {
  return { ...(await readState(deps)), fields: MOBILE_CONFIG_FIELDS };
}

/**
 * Applies a patch (the same body PUT /api/v1/app-config takes, validated by appConfigPatch). Throws a 422 HttpError
 * on bad input without writing. Returns the state before and after for the audit row.
 */
export async function updateMobileConfig(deps: Pick<Deps, "db" | "config" | "now" | "log">, patch: unknown, actor: MobileConfigActor): Promise<{ before: MobileConfigState; after: MobileConfigState }> {
  const r = appConfigPatch.safeParse(patch);
  if (!r.success) throw zodToHttp(r.error);
  const p: AppConfigPatch = r.data;
  const before = await readState(deps);
  const next = mergePatch(before.stored, p);
  const updatedAt = deps.now().toISOString();
  const updatedBy = `console:${actor.userId}`;
  const value = JSON.stringify({ config: next, updated_at: updatedAt, updated_by: updatedBy });
  await deps.db.insert(appSettings).values({ key: APP_CONFIG_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  deps.log?.info?.("app_config_updated", { by: updatedBy, keys: Object.keys(p) });
  return { before, after: { stored: next, effective: resolveAppConfig(next, deps.config.mobileApp?.sentryDsn, updatedAt).mobile, updatedAt, updatedBy } };
}
