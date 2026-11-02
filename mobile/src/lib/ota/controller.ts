/**
 * The update controller: launch reports, remote config, throttled checks on launch and on resume,
 * critical updates applied at once, and the "What's new" gate. Everything native is injected, so the
 * whole flow is unit tested with fakes (__tests__/ota-controller.test.ts); src/lib/ota/provider.tsx
 * wires the real expo-updates module, AppState and fetch.
 */
import type { KV } from "@/lib/kv";
import type { VersionFacts } from "@/lib/app-version";
import { armLaunch, launchReports, markStable, STABLE_AFTER_MS, type LogEntry } from "./lifecycle";
import { applyPendingOnResume, decideApply, DEFAULT_CONFIG, needsStoreUpdate, shouldCheck, shouldShowWhatsNew, type CheckReason, type MobileConfig, type OsName } from "./policy";
import type { Telemetry } from "./telemetry";
import type { WhatsNewItem } from "./whats-new.generated";

export type UpdatesApi = {
  isEnabled: boolean;
  isEmergencyLaunch: boolean;
  emergencyLaunchReason: string | null;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean; manifest?: { id?: string } | null; isRollBackToEmbedded?: boolean }>;
  fetchUpdateAsync(): Promise<{ isNew: boolean; manifest?: { id?: string } | null; isRollBackToEmbedded?: boolean }>;
  reloadAsync(): Promise<void>;
  readLogEntriesAsync(maxAge?: number): Promise<LogEntry[]>;
};

export type OtaStatus = "idle" | "checking" | "downloading" | "up_to_date" | "ready" | "installing" | "error";

export type OtaState = {
  config: MobileConfig;
  status: OtaStatus;
  lastCheckAt: number | null;
  /** True when this store build is below the server's minimum: the app shows only the update screen. */
  storeUpdateRequired: boolean;
  /** The short notice shown before a critical update reloads the app. */
  notice: string | null;
  whatsNew: { version: string; items: WhatsNewItem[] } | null;
};

export type OtaDeps = {
  os: OsName;
  facts: () => VersionFacts;
  updates: UpdatesApi | null;
  store: KV;
  telemetry: Telemetry;
  fetchConfig: () => Promise<MobileConfig | null>;
  cachedConfig: () => Promise<MobileConfig | null>;
  notes: Record<string, WhatsNewItem[]>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** How long the critical notice shows before the reload. */
  noticeMs?: number;
  /** Wait before the launch check, so it never races the download expo-updates starts natively at launch. */
  launchCheckDelayMs?: number;
  /** AppState.currentState when the app started. iOS can start the app in the background (a push wakes it). */
  launchAppState?: () => string | null | undefined;
};

const LAST_CHECK = "ota:last-check-at";
const WHATS_NEW_SEEN = "ota:whats-new-seen";
export const CRITICAL_NOTICE = "Installing an important update. Multies restarts in a moment.";

export function createOtaController(d: OtaDeps) {
  const now = d.now ?? Date.now;
  const timer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let state: OtaState = { config: DEFAULT_CONFIG, status: "idle", lastCheckAt: null, storeUpdateRequired: false, notice: null, whatsNew: null };
  const listeners = new Set<(s: OtaState) => void>();
  const set = (p: Partial<OtaState>) => { state = { ...state, ...p }; for (const l of listeners) l(state); };
  let backgroundAt: number | null = null;
  // Started in the background: the 10 s crash window starts the first time the app is actually opened.
  let armOnActive = false;
  let configAt = 0;
  let pending = false;
  let checking: Promise<void> | null = null;

  const applyConfig = (c: MobileConfig) => {
    const f = d.facts();
    d.telemetry.setDsn(c.telemetry.sentryDsn, c.telemetry.sampleRate);
    set({ config: c, storeUpdateRequired: needsStoreUpdate({ version: f.nativeVersion, build: f.nativeBuild }, c.minSupported[d.os]) });
  };

  const refreshConfig = async () => {
    const c = await d.fetchConfig();
    if (c) { configAt = now(); applyConfig(c); }
    void d.telemetry.flush();
  };

  const reload = async (notice: string | null) => {
    if (!d.updates) return;
    set({ status: "installing", notice });
    await new Promise<void>((r) => { timer(() => r(), notice ? d.noticeMs ?? 1800 : 0); });
    await d.telemetry.flush();
    // A restart we ask for is not a crash: mark this launch stable first, or the next start reports
    // "The app closed within 10 s of starting" for every update applied at launch (Sentry MYMAIL-WEB-H, WEB-K).
    await markStable(d.store);
    try { await d.updates.reloadAsync(); } catch { set({ status: "ready", notice: null }); }
  };

  const check = async (reason: CheckReason, awayMs = 0): Promise<void> => {
    const u = d.updates;
    if (!u || !u.isEnabled || state.storeUpdateRequired) return;
    if (checking) return checking;
    const last = state.lastCheckAt;
    if (!shouldCheck({ reason, now: now(), lastCheckAt: last, awayMs, intervalMinutes: state.config.ota.checkIntervalMinutes })) return;
    checking = (async () => {
      const at = now();
      set({ status: "checking", lastCheckAt: at });
      try { await d.store.set(LAST_CHECK, String(at)); } catch { /* best effort */ }
      let res;
      try { res = await u.checkForUpdateAsync(); } catch { set({ status: pending ? "ready" : "error" }); return; }
      const newId = res.manifest?.id ?? null;
      const decision = decideApply({ available: res.isAvailable, newUpdateId: newId, rollBackToEmbedded: res.isRollBackToEmbedded, runningUpdateId: d.facts().embedded ? null : d.facts().updateId, config: state.config });
      if (decision === "none") { set({ status: pending ? "ready" : "up_to_date" }); return; }
      set({ status: "downloading" });
      try {
        await u.fetchUpdateAsync();
      } catch (e) {
        void d.telemetry.record({ event: "download_failed", updateId: newId, message: "Update download failed", error: { type: "UpdateDownloadError", value: String((e as Error)?.message ?? e).slice(0, 300) } });
        set({ status: "error" });
        return;
      }
      pending = true;
      if (decision === "now") { await reload(CRITICAL_NOTICE); return; }
      set({ status: "ready" });
    })().finally(() => { checking = null; });
    return checking;
  };

  return {
    get state() { return state; },
    subscribe(l: (s: OtaState) => void) { listeners.add(l); return () => { listeners.delete(l); }; },

    /** Run once at app start. */
    async start() {
      const cached = await d.cachedConfig();
      if (cached) applyConfig(cached);
      try { const v = await d.store.get(LAST_CHECK); if (v) set({ lastCheckAt: Number(v) }); } catch { /* best effort */ }

      const f = d.facts();
      const u = d.updates;
      if (u && u.isEnabled) {
        let logs: LogEntry[] = [];
        try { logs = await u.readLogEntriesAsync(24 * 3600_000); } catch { /* older native module */ }
        const reports = await launchReports(d.store, { updateId: f.updateId, embedded: f.embedded, emergency: u.isEmergencyLaunch, emergencyReason: u.emergencyLaunchReason }, logs, now());
        for (const r of reports) await d.telemetry.record(r);
        if (d.launchAppState?.() === "background") {
          // iOS woke the app for a push and will suspend it, so the 10 s timer may never run and iOS
          // ends the process later. That is not a crash (Sentry MYMAIL-WEB-Q, WEB-K, WEB-H).
          await markStable(d.store);
          armOnActive = true;
        } else {
          timer(() => { void markStable(d.store); }, STABLE_AFTER_MS);
        }
      }

      // What's new: once, on the first start of a newer JavaScript version (never on a fresh install).
      try {
        const seen = await d.store.get(WHATS_NEW_SEEN);
        const items = d.notes[f.jsVersion] ?? [];
        if (shouldShowWhatsNew({ jsVersion: f.jsVersion, lastSeenVersion: seen, hasNotes: items.length > 0 })) set({ whatsNew: { version: f.jsVersion, items } });
        else if (seen !== f.jsVersion) await d.store.set(WHATS_NEW_SEEN, f.jsVersion);
      } catch { /* best effort */ }

      await refreshConfig();
      // The native side already checks at launch; this check reads the answer for the critical flag.
      const delay = d.launchCheckDelayMs ?? 8000;
      if (delay > 0) await new Promise<void>((r) => { timer(() => r(), delay); });
      await check("launch");
    },

    /** AppState changes: "active" after time away checks again (throttled), background marks the launch stable. */
    async onAppState(next: string) {
      if (next === "active" && armOnActive) {
        armOnActive = false;
        await armLaunch(d.store, now());
        timer(() => { void markStable(d.store); }, STABLE_AFTER_MS);
      }
      if (next === "background" || next === "inactive") {
        if (backgroundAt === null) backgroundAt = now();
        if (next === "background") void markStable(d.store);
        return;
      }
      if (next !== "active" || backgroundAt === null) return;
      const awayMs = now() - backgroundAt;
      backgroundAt = null;
      if (awayMs < 30_000) return;
      if (now() - configAt > 5 * 60_000) await refreshConfig();
      if (state.storeUpdateRequired) return;
      if (applyPendingOnResume({ pending, awayMs, config: state.config })) { await reload(null); return; }
      await check("resume", awayMs);
    },

    checkNow: () => check("manual"),
    restartNow: () => reload(null),
    async dismissWhatsNew() {
      const v = state.whatsNew?.version ?? d.facts().jsVersion;
      set({ whatsNew: null });
      try { await d.store.set(WHATS_NEW_SEEN, v); } catch { /* best effort */ }
    },
  };
}

export type OtaController = ReturnType<typeof createOtaController>;
