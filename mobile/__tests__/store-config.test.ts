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
  it("is version 1.8.0, build 9 on both stores", () => {
    expect(app.version).toBe("1.8.0");
    expect(app.ios.buildNumber).toBe("9");
    expect(app.android.versionCode).toBe(9);
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

  it("keeps the reference copy of the privacy manifest in step with app.json", () => {
    const ref = readFileSync(join(root, "store/ios/PrivacyInfo.xcprivacy"), "utf8");
    for (const t of app.ios.privacyManifests.NSPrivacyCollectedDataTypes) expect(ref).toContain(t.NSPrivacyCollectedDataType);
    for (const a of app.ios.privacyManifests.NSPrivacyAccessedAPITypes) for (const r of a.NSPrivacyAccessedAPITypeReasons) expect(ref).toContain(`<string>${r}</string>`);
  });
});
