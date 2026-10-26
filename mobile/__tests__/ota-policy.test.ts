import { applyPendingOnResume, compareVersions, decideApply, DEFAULT_CONFIG, needsStoreUpdate, parseAppConfig, safeDsn, safeStoreUrl, shouldCheck, shouldShowWhatsNew } from "@/lib/ota/policy";

const cfg = (ota: Partial<typeof DEFAULT_CONFIG.ota> = {}) => ({ ...DEFAULT_CONFIG, ota: { ...DEFAULT_CONFIG.ota, ...ota } });

describe("parseAppConfig", () => {
  it("reads the server's answer", () => {
    const c = parseAppConfig({ mobile: {
      min_supported: { ios: { build: 17, version: null }, android: { build: "15", version: "1.9.3" } },
      store_url: { ios: "https://apps.apple.com/app/id6826562106", android: "https://play.google.com/store/apps/details?id=au.fintex.multies" },
      ota: { critical_update_ids: ["a1"], blocked_update_ids: ["b1", 7], check_interval_minutes: 15, apply_on_resume_after_minutes: null },
      telemetry: { sentry_dsn: "https://abc123@o1.ingest.sentry.io/42", sample_rate: 0.5 },
      message: "Please update",
    } });
    expect(c.minSupported).toEqual({ ios: { build: 17, version: null }, android: { build: 15, version: "1.9.3" } });
    expect(c.ota).toEqual({ criticalUpdateIds: ["a1"], blockedUpdateIds: ["b1"], checkIntervalMinutes: 15, applyOnResumeAfterMinutes: null });
    expect(c.telemetry).toEqual({ sentryDsn: "https://abc123@o1.ingest.sentry.io/42", sampleRate: 0.5 });
    expect(c.message).toBe("Please update");
  });

  it("falls back to safe defaults that never block on junk", () => {
    for (const junk of [null, undefined, "x", 42, [], { mobile: "nope" }, { mobile: { min_supported: { ios: { build: "abc" } } } }]) {
      const c = parseAppConfig(junk);
      expect(c.minSupported.ios.build).toBeNull();
      expect(c.ota.checkIntervalMinutes).toBe(30);
      expect(c.ota.applyOnResumeAfterMinutes).toBe(240);
    }
  });

  it("clamps the throttle and refuses foreign store links and odd DSNs", () => {
    expect(parseAppConfig({ mobile: { ota: { check_interval_minutes: 1 } } }).ota.checkIntervalMinutes).toBe(5);
    expect(parseAppConfig({ mobile: { ota: { check_interval_minutes: 99999 } } }).ota.checkIntervalMinutes).toBe(1440);
    expect(parseAppConfig({ mobile: { ota: { apply_on_resume_after_minutes: 1 } } }).ota.applyOnResumeAfterMinutes).toBe(15);
    expect(safeStoreUrl("https://evil.example/app")).toBeNull();
    expect(safeStoreUrl("http://apps.apple.com/app/id1")).toBeNull();
    expect(safeStoreUrl("https://play.google.com/store/apps/details?id=x")).toBe("https://play.google.com/store/apps/details?id=x");
    expect(safeDsn("javascript:alert(1)")).toBeNull();
  });
});

describe("store build minimum (force update)", () => {
  it("compares build numbers when both sides have one", () => {
    expect(needsStoreUpdate({ version: "1.9.3", build: "16" }, { build: 17, version: null })).toBe(true);
    expect(needsStoreUpdate({ version: "1.9.3", build: "17" }, { build: 17, version: null })).toBe(false);
    expect(needsStoreUpdate({ version: "1.9.3", build: "18" }, { build: 17, version: "2.0.0" })).toBe(false);
  });
  it("falls back to the store version, numerically", () => {
    expect(needsStoreUpdate({ version: "1.9.3", build: null }, { build: 17, version: "1.9.10" })).toBe(true);
    expect(needsStoreUpdate({ version: "1.10.0", build: null }, { build: null, version: "1.9.10" })).toBe(false);
  });
  it("never blocks on unknown facts", () => {
    expect(needsStoreUpdate({ version: null, build: null }, { build: 99, version: "9.9.9" })).toBe(false);
    expect(needsStoreUpdate({ version: "1.0.0", build: "1" }, { build: null, version: null })).toBe(false);
  });
  it("orders versions", () => {
    expect(compareVersions("1.9.10", "1.9.9")).toBe(1);
    expect(compareVersions("1.9", "1.9.0")).toBe(0);
    expect(compareVersions("1.8.9", "1.9.0")).toBe(-1);
  });
});

describe("check throttling", () => {
  const now = 10_000_000;
  it("always checks on demand", () => expect(shouldCheck({ reason: "manual", now, lastCheckAt: now, intervalMinutes: 30 })).toBe(true));
  it("checks at launch unless one ran in the last minute", () => {
    expect(shouldCheck({ reason: "launch", now, lastCheckAt: null, intervalMinutes: 30 })).toBe(true);
    expect(shouldCheck({ reason: "launch", now, lastCheckAt: now - 30_000, intervalMinutes: 30 })).toBe(false);
  });
  it("checks on resume only after time away and past the interval", () => {
    expect(shouldCheck({ reason: "resume", now, lastCheckAt: now - 31 * 60_000, awayMs: 5_000, intervalMinutes: 30 })).toBe(false);
    expect(shouldCheck({ reason: "resume", now, lastCheckAt: now - 29 * 60_000, awayMs: 600_000, intervalMinutes: 30 })).toBe(false);
    expect(shouldCheck({ reason: "resume", now, lastCheckAt: now - 31 * 60_000, awayMs: 60_000, intervalMinutes: 30 })).toBe(true);
    expect(shouldCheck({ reason: "resume", now, lastCheckAt: null, awayMs: 60_000, intervalMinutes: 30 })).toBe(true);
  });
});

describe("when to apply", () => {
  it("waits for the next cold start by default", () => {
    expect(decideApply({ available: true, newUpdateId: "n1", runningUpdateId: "r1", config: cfg() })).toBe("next_launch");
    expect(decideApply({ available: false, newUpdateId: null, runningUpdateId: "r1", config: cfg({ criticalUpdateIds: ["n1"] }) })).toBe("none");
  });
  it("applies a critical update now", () => {
    expect(decideApply({ available: true, newUpdateId: "n1", runningUpdateId: "r1", config: cfg({ criticalUpdateIds: ["n1"] }) })).toBe("now");
  });
  it("leaves a rolled back update at once, including back to the store bundle", () => {
    expect(decideApply({ available: true, newUpdateId: null, rollBackToEmbedded: true, runningUpdateId: "bad", config: cfg({ blockedUpdateIds: ["bad"] }) })).toBe("now");
    expect(decideApply({ available: true, newUpdateId: "n2", runningUpdateId: null, config: cfg({ blockedUpdateIds: ["bad"] }) })).toBe("next_launch");
  });
  it("applies a waiting update on resume only after a long time away", () => {
    expect(applyPendingOnResume({ pending: true, awayMs: 239 * 60_000, config: cfg() })).toBe(false);
    expect(applyPendingOnResume({ pending: true, awayMs: 240 * 60_000, config: cfg() })).toBe(true);
    expect(applyPendingOnResume({ pending: false, awayMs: 9e9, config: cfg() })).toBe(false);
    expect(applyPendingOnResume({ pending: true, awayMs: 9e9, config: cfg({ applyOnResumeAfterMinutes: null }) })).toBe(false);
  });
});

describe("What's new gate", () => {
  it("shows once for a newer version with notes, never on a fresh install", () => {
    expect(shouldShowWhatsNew({ jsVersion: "1.9.6", lastSeenVersion: "1.9.5", hasNotes: true })).toBe(true);
    expect(shouldShowWhatsNew({ jsVersion: "1.9.6", lastSeenVersion: "1.9.6", hasNotes: true })).toBe(false);
    expect(shouldShowWhatsNew({ jsVersion: "1.9.6", lastSeenVersion: null, hasNotes: true })).toBe(false);
    expect(shouldShowWhatsNew({ jsVersion: "1.9.6", lastSeenVersion: "1.9.5", hasNotes: false })).toBe(false);
  });
});
