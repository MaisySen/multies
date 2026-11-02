import { memoryKV } from "@/lib/kv";
import { createOtaController, CRITICAL_NOTICE, type UpdatesApi } from "@/lib/ota/controller";
import { launchReports, markStable } from "@/lib/ota/lifecycle";
import { DEFAULT_CONFIG, type MobileConfig } from "@/lib/ota/policy";
import type { Telemetry } from "@/lib/ota/telemetry";
import type { VersionFacts } from "@/lib/app-version";

const facts: VersionFacts = { jsVersion: "1.9.6", nativeVersion: "1.9.3", nativeBuild: "17", embedded: false, updateId: "run-1", channel: "production", runtimeVersion: "e184" };

function fakeUpdates(o: Partial<UpdatesApi> = {}): UpdatesApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEnabled: o.isEnabled ?? true,
    isEmergencyLaunch: false,
    emergencyLaunchReason: null,
    checkForUpdateAsync: async () => { calls.push("check"); return o.checkForUpdateAsync ? o.checkForUpdateAsync() : { isAvailable: false }; },
    fetchUpdateAsync: async () => { calls.push("fetch"); return o.fetchUpdateAsync ? o.fetchUpdateAsync() : { isNew: true }; },
    reloadAsync: async () => { calls.push("reload"); },
    readLogEntriesAsync: async () => [],
  };
}

function setup(o: { updates?: UpdatesApi; config?: Partial<MobileConfig>; f?: Partial<VersionFacts>; store?: ReturnType<typeof memoryKV> } = {}) {
  let clock = 1_000_000_000;
  const store = o.store ?? memoryKV();
  const records: { event: string; updateId: string | null }[] = [];
  const telemetry: Telemetry = { record: async (r) => { records.push(r); }, flush: async () => 0, setDsn: jest.fn() };
  const config = { ...DEFAULT_CONFIG, ...o.config };
  const updates = o.updates ?? fakeUpdates();
  const c = createOtaController({
    os: "ios", facts: () => ({ ...facts, ...o.f }), updates, store, telemetry,
    fetchConfig: async () => config, cachedConfig: async () => null,
    notes: { "1.9.6": [{ title: "What's new", body: "A sheet." }] },
    now: () => clock, setTimer: (fn) => { fn(); return 0; }, noticeMs: 0, launchCheckDelayMs: 0,
  });
  return { c, store, records, telemetry, updates, tick: (ms: number) => { clock += ms; } };
}

describe("update controller", () => {
  it("checks at launch and leaves a normal update for the next cold start", async () => {
    const updates = fakeUpdates({ checkForUpdateAsync: async () => ({ isAvailable: true, manifest: { id: "new-1" } }) });
    const { c } = setup({ updates });
    await c.start();
    expect((updates as ReturnType<typeof fakeUpdates>).calls).toEqual(["check", "fetch"]);
    expect(c.state.status).toBe("ready");
    expect(c.state.notice).toBeNull();
  });

  it("applies a critical update at once with a short notice", async () => {
    const updates = fakeUpdates({ checkForUpdateAsync: async () => ({ isAvailable: true, manifest: { id: "crit-1" } }) });
    const seen: (string | null)[] = [];
    const { c } = setup({ updates, config: { ota: { ...DEFAULT_CONFIG.ota, criticalUpdateIds: ["crit-1"] } } });
    c.subscribe((s) => seen.push(s.notice));
    await c.start();
    expect((updates as ReturnType<typeof fakeUpdates>).calls).toEqual(["check", "fetch", "reload"]);
    expect(seen).toContain(CRITICAL_NOTICE);
  });

  it("moves a phone off a rolled back update at once", async () => {
    const updates = fakeUpdates({ checkForUpdateAsync: async () => ({ isAvailable: true, isRollBackToEmbedded: true }) });
    const { c } = setup({ updates, config: { ota: { ...DEFAULT_CONFIG.ota, blockedUpdateIds: ["run-1"] } } });
    await c.start();
    expect((updates as ReturnType<typeof fakeUpdates>).calls).toContain("reload");
  });

  it("blocks an unsupported store build with the update screen and stops checking", async () => {
    const updates = fakeUpdates();
    const { c } = setup({ updates, config: { minSupported: { ios: { build: 18, version: null }, android: { build: null, version: null } } } });
    await c.start();
    expect(c.state.storeUpdateRequired).toBe(true);
    expect((updates as ReturnType<typeof fakeUpdates>).calls).toEqual([]);
  });

  it("checks again on resume only after time away and past the interval", async () => {
    const updates = fakeUpdates();
    const u = updates as ReturnType<typeof fakeUpdates>;
    const { c, tick } = setup({ updates });
    await c.start();
    expect(u.calls).toEqual(["check"]);
    await c.onAppState("background"); tick(10_000); await c.onAppState("active");
    expect(u.calls).toEqual(["check"]);
    await c.onAppState("background"); tick(10 * 60_000); await c.onAppState("active");
    expect(u.calls).toEqual(["check"]);
    await c.onAppState("background"); tick(25 * 60_000); await c.onAppState("active");
    expect(u.calls).toEqual(["check", "check"]);
    expect(c.state.status).toBe("up_to_date");
  });

  it("applies a downloaded update on resume after a long time away", async () => {
    const updates = fakeUpdates({ checkForUpdateAsync: async () => ({ isAvailable: true, manifest: { id: "n" } }) });
    const u = updates as ReturnType<typeof fakeUpdates>;
    const { c, tick } = setup({ updates });
    await c.start();
    await c.onAppState("background"); tick(5 * 3600_000); await c.onAppState("active");
    expect(u.calls.at(-1)).toBe("reload");
  });

  it("reports a failed download with the update id, and a manual check always runs", async () => {
    let n = 0;
    const updates = fakeUpdates({
      checkForUpdateAsync: async () => ({ isAvailable: true, manifest: { id: "n1" } }),
      fetchUpdateAsync: async () => { n++; throw new Error("network lost"); },
    });
    const { c, records } = setup({ updates });
    await c.start();
    expect(records).toContainEqual(expect.objectContaining({ event: "download_failed", updateId: "n1" }));
    expect(c.state.status).toBe("error");
    await c.checkNow();
    expect(n).toBe(2);
  });

  it("shows What's new once after an update, and not on a fresh install", async () => {
    const fresh = setup();
    await fresh.c.start();
    expect(fresh.c.state.whatsNew).toBeNull();

    const store = memoryKV({ "ota:whats-new-seen": "1.9.5" });
    const upd = setup({ store });
    await upd.c.start();
    expect(upd.c.state.whatsNew?.version).toBe("1.9.6");
    await upd.c.dismissWhatsNew();
    expect(upd.c.state.whatsNew).toBeNull();
    const again = setup({ store });
    await again.c.start();
    expect(again.c.state.whatsNew).toBeNull();
  });

  it("does nothing without expo-updates (web, Expo Go)", async () => {
    const { c, records } = setup({ updates: fakeUpdates({ isEnabled: false }) });
    await c.start();
    expect(records).toEqual([]);
    expect(c.state.status).toBe("idle");
  });
});

describe("launch reports", () => {
  const base = { updateId: "u1", embedded: false, emergency: false, emergencyReason: null };

  it("reports an update once, the first time it runs", async () => {
    const store = memoryKV();
    expect((await launchReports(store, base, [], 1)).map((r) => r.event)).toEqual(["applied"]);
    await markStable(store);
    expect(await launchReports(store, base, [], 2)).toEqual([]);
  });

  it("reports a launch that died before it was stable, for the update it ran", async () => {
    const store = memoryKV();
    await launchReports(store, base, [], 1);
    const r = await launchReports(store, { ...base, updateId: "u2" }, [], 2);
    expect(r.map((x) => [x.event, x.updateId])).toEqual([["launch_crash", "u1"], ["applied", "u2"]]);
  });

  it("reports an emergency launch and new update errors from the expo-updates log, once", async () => {
    const store = memoryKV();
    const logs = [
      { timestamp: 10, message: "bundle failed", code: "UpdateFailedToLoad", level: "error", updateId: "bad-1" },
      { timestamp: 11, message: "offline", code: "NoUpdatesAvailable", level: "info" },
    ];
    const r = await launchReports(store, { ...base, embedded: true, updateId: null, emergency: true, emergencyReason: "crash" }, logs, 1);
    expect(r.map((x) => [x.event, x.updateId])).toEqual([["failed", null], ["failed", "bad-1"]]);
    await markStable(store);
    expect(await launchReports(store, { ...base, embedded: true, updateId: null }, logs, 2)).toEqual([]);
  });
});
