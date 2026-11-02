/**
 * Wires the update controller (controller.ts) to the real app: expo-updates, AppState, fetch and the
 * on-device store. Renders the blocking store update screen, the critical update notice and the
 * "What's new" sheet. On web and in tests (no expo-updates) it only passes children through.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import * as Updates from "expo-updates";
import { API_BASE, SAMPLE_ONLY } from "@/config";
import { kv } from "@/lib/kv";
import { currentVersionFacts } from "@/lib/app-version";
import { cachedAppConfig, fetchAppConfig } from "./app-config";
import { createOtaController, type OtaController, type OtaState, type UpdatesApi } from "./controller";
import { installCrashHandler } from "./crash-handler";
import { createTelemetry, installationId } from "./telemetry";
import { WHATS_NEW } from "./whats-new.generated";
import { CriticalUpdateNotice, StoreUpdateScreen, WhatsNewSheet } from "@/components/ota";

/** Read once at module load: "background" when iOS started the app for a push. */
const LAUNCH_APP_STATE = AppState.currentState;

const OtaContext = createContext<{ state: OtaState; controller: OtaController } | null>(null);

/** The controller's state and actions for screens (Settings, About). Null on web and in tests. */
export function useOta() { return useContext(OtaContext); }

let singleton: OtaController | null = null;

function updatesApi(): UpdatesApi | null {
  try {
    if (!Updates.isEnabled) return null;
    return {
      isEnabled: Updates.isEnabled,
      isEmergencyLaunch: Updates.isEmergencyLaunch,
      emergencyLaunchReason: Updates.emergencyLaunchReason ?? null,
      checkForUpdateAsync: () => Updates.checkForUpdateAsync() as ReturnType<UpdatesApi["checkForUpdateAsync"]>,
      fetchUpdateAsync: () => Updates.fetchUpdateAsync() as ReturnType<UpdatesApi["fetchUpdateAsync"]>,
      reloadAsync: () => Updates.reloadAsync(),
      readLogEntriesAsync: (age) => Updates.readLogEntriesAsync(age) as unknown as ReturnType<UpdatesApi["readLogEntriesAsync"]>,
    };
  } catch {
    return null;
  }
}

function controller(): OtaController | null {
  if (singleton) return singleton;
  if (Platform.OS === "web" || process.env.NODE_ENV === "test") return null;
  const store = kv();
  const facts = () => currentVersionFacts();
  const os = Platform.OS === "ios" ? "ios" : "android";
  const telemetry = createTelemetry({
    store,
    installId: () => installationId(store),
    tags: () => { const f = facts(); return { updateId: f.embedded ? null : f.updateId, channel: f.channel, runtimeVersion: f.runtimeVersion ?? null, jsVersion: f.jsVersion, nativeVersion: f.nativeVersion, nativeBuild: f.nativeBuild, embedded: f.embedded, os }; },
  });
  installCrashHandler(telemetry, { updateId: () => { const f = facts(); return f.embedded ? null : f.updateId; } });
  singleton = createOtaController({
    os,
    facts,
    updates: SAMPLE_ONLY ? null : updatesApi(),
    store,
    telemetry,
    notes: WHATS_NEW,
    launchAppState: () => LAUNCH_APP_STATE,
    cachedConfig: async () => (await cachedAppConfig(store))?.config ?? null,
    fetchConfig: () => {
      const f = facts();
      return fetchAppConfig({ base: API_BASE, store, query: { platform: os, version: f.nativeVersion, build: f.nativeBuild, js: f.jsVersion, update: f.embedded ? null : f.updateId, channel: f.channel } });
    },
  });
  return singleton;
}

export function OtaProvider({ children }: { children: ReactNode }) {
  const c = useMemo(() => controller(), []);
  const [state, setState] = useState<OtaState | null>(c?.state ?? null);
  useEffect(() => {
    if (!c) return;
    const off = c.subscribe(setState);
    void c.start();
    const sub = AppState.addEventListener("change", (s) => { void c.onAppState(s); });
    return () => { off(); sub.remove(); };
  }, [c]);

  if (!c || !state) return <>{children}</>;
  if (state.storeUpdateRequired) {
    const os = Platform.OS === "ios" ? "ios" : "android";
    return <StoreUpdateScreen storeUrl={state.config.storeUrl[os]} os={os} message={state.config.message} />;
  }
  return (
    <OtaContext.Provider value={{ state, controller: c }}>
      {children}
      {state.notice ? <CriticalUpdateNotice text={state.notice} /> : null}
      {state.whatsNew ? <WhatsNewSheet version={state.whatsNew.version} items={state.whatsNew.items} onClose={() => { void c.dismissWhatsNew(); }} /> : null}
    </OtaContext.Provider>
  );
}
