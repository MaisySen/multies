/* Store readiness checks on the app config: versions, iPhone only, export compliance, privacy manifest. */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..");
const app = JSON.parse(readFileSync(join(root, "app.json"), "utf8")).expo;
const eas = JSON.parse(readFileSync(join(root, "eas.json"), "utf8"));

function privacyFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "example" || name === "__tests__" || name === ".bin") continue;
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) { if (p.split("node_modules").length < 5) privacyFiles(p, out); }
    else if (name === "PrivacyInfo.xcprivacy") out.push(p);
  }
  return out;
}

describe("store config", () => {
  it("is version 1.10.0, iOS build 20 and Android versionCode 16 (R37 store build, native batch 1)", () => {
    expect(app.version).toBe("1.10.0");
    expect(app.ios.buildNumber).toBe("20");
    expect(app.android.versionCode).toBe(16);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.10.0");
  });

  it("talks to multies.si in every build profile, never an old preview or workers.dev host", () => {
    expect(app.extra.apiBase).toBe("https://multies.si");
    expect(eas.build.production.env.EXPO_PUBLIC_API_BASE).toBe("https://multies.si");
    expect(eas.build.preview.env.EXPO_PUBLIC_API_BASE).toBe("https://multies.si");
    expect(eas.build.development.env.EXPO_PUBLIC_API_BASE).toBe("https://preview.multies.si");
    for (const text of [JSON.stringify(app), JSON.stringify(eas)]) {
      expect(text).not.toMatch(/tab\.bot|workers\.dev/);
    }
  });

  it("is iPhone only, declares standard encryption only and keeps release signing in prebuild", () => {
    expect(app.ios.supportsTablet).toBe(false);
    expect(app.ios.config.usesNonExemptEncryption).toBe(false);
    expect(app.plugins).toContain("./plugins/with-release-signing");
    expect(eas.build.production.android.buildType).toBe("app-bundle");
  });

  it("declares every required reason API the bundled native modules use", () => {
    const declared = new Map<string, string[]>(app.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((a: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons]));
    const used = new Set<string>();
    for (const f of privacyFiles(join(root, "node_modules"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/<string>(NSPrivacyAccessedAPICategory\w+)<\/string>/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const cat of used) expect(declared.has(cat)).toBe(true);
    expect(app.ios.privacyManifests.NSPrivacyTracking).toBe(false);
  });

  it("declares the collected data the App Privacy answers give: nothing tracks, diagnostics linked (round 16)", () => {
    const types = app.ios.privacyManifests.NSPrivacyCollectedDataTypes as { NSPrivacyCollectedDataType: string; NSPrivacyCollectedDataTypeLinked: boolean; NSPrivacyCollectedDataTypeTracking: boolean }[];
    for (const t of types) expect(t.NSPrivacyCollectedDataTypeTracking).toBe(false);
    expect(app.ios.privacyManifests.NSPrivacyTrackingDomains).toEqual([]);
    const diag = types.find((t) => t.NSPrivacyCollectedDataType === "NSPrivacyCollectedDataTypeOtherDiagnosticData");
    expect(diag?.NSPrivacyCollectedDataTypeLinked).toBe(true);
    const reasons = new Map(app.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((a: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons]));
    expect(reasons.get("NSPrivacyAccessedAPICategoryUserDefaults")).toContain("CA92.1");
    expect(reasons.get("NSPrivacyAccessedAPICategoryFileTimestamp")).toContain("C617.1");
    expect(reasons.get("NSPrivacyAccessedAPICategorySystemBootTime")).toContain("35F9.1");
    expect(reasons.get("NSPrivacyAccessedAPICategoryDiskSpace")).toContain("E174.1");
  });

  it("keeps the reference copy of the privacy manifest in step with app.json", () => {
    const ref = readFileSync(join(root, "store/ios/PrivacyInfo.xcprivacy"), "utf8");
    for (const t of app.ios.privacyManifests.NSPrivacyCollectedDataTypes) expect(ref).toContain(t.NSPrivacyCollectedDataType);
    for (const a of app.ios.privacyManifests.NSPrivacyAccessedAPITypes) for (const r of a.NSPrivacyAccessedAPITypeReasons) expect(ref).toContain(`<string>${r}</string>`);
  });
});

describe("EAS Update config", () => {
  const app = JSON.parse(readFileSync(join(__dirname, "..", "app.json"), "utf8")).expo;
  const eas = JSON.parse(readFileSync(join(__dirname, "..", "eas.json"), "utf8"));
  it("uses the fingerprint runtime version and checks on launch without blocking it", () => {
    expect(app.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(app.updates.url).toBe(`https://u.expo.dev/${app.extra.eas.projectId}`);
    expect(app.updates.checkAutomatically).toBe("ON_LOAD");
    expect(app.updates.fallbackToCacheTimeout).toBe(0);
    expect(app.updates.requestHeaders["expo-channel-name"]).toBe("production");
  });
  it("maps every build profile to its channel", () => {
    expect(eas.build.development.channel).toBe("development");
    expect(eas.build.preview.channel).toBe("preview");
    expect(eas.build.production.channel).toBe("production");
    expect(eas.build["production-local-credentials"].extends).toBe("production");
  });
});

