/* The guard in front of npm run ota:preview and npm run ota:production (scripts/ota-guard.js). */
const { bundleEnv, commitsFromViews, evaluateGuard, groupIdsFromList, nativeChanges, latestGroupsByPlatform, rolloutOf, parseFlags } = require("../scripts/ota-guard");
const { readFileSync, readdirSync } = require("fs");
const { join } = require("path");
const eas = require("../eas.json");

const store = { android: { runtimeVersion: "aaaaaaaaaaaaaaaa" }, ios: { runtimeVersion: "bbbbbbbbbbbbbbbb" } };
const same = { android: "aaaaaaaaaaaaaaaa", ios: "bbbbbbbbbbbbbbbb" };
const base = { channel: "preview", dirty: false, current: same, store, nativeFiles: [], head: "9ededbe9b5570d6d", previewCommits: [] };

describe("ota guard", () => {
  it("lets a JavaScript only change go to preview", () => {
    expect(evaluateGuard(base)).toEqual({ ok: true, problems: [] });
  });

  it("refuses when the Android fingerprint changed", () => {
    const r = evaluateGuard({ ...base, current: { ...same, android: "cccccccccccccccc" } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/android fingerprint changed.*new store build/);
  });

  it("refuses when the iOS fingerprint changed", () => {
    const r = evaluateGuard({ ...base, current: { ...same, ios: "dddddddddddddddd" } });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/ios fingerprint changed/);
  });

  it("refuses when a fingerprint could not be worked out or no store build is recorded", () => {
    expect(evaluateGuard({ ...base, current: { ios: same.ios } }).problems[0]).toMatch(/Could not work out the android fingerprint/);
    expect(evaluateGuard({ ...base, store: { ios: store.ios } }).problems[0]).toMatch(/No store build is recorded for android/);
  });

  it("refuses when native files changed even if the fingerprint did not", () => {
    const r = evaluateGuard({ ...base, nativeFiles: ["plugins/with-release-signing.js"] });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Native files changed since the store build: plugins\/with-release-signing.js/);
  });

  it("refuses uncommitted work and unknown channels", () => {
    expect(evaluateGuard({ ...base, dirty: true }).problems[0]).toMatch(/uncommitted/);
    expect(evaluateGuard({ ...base, channel: "staging" }).problems[0]).toMatch(/Unknown channel/);
  });

  it("needs the same commit on preview before production", () => {
    expect(evaluateGuard({ ...base, channel: "production" }).problems[0]).toMatch(/not on the preview channel yet/);
    expect(evaluateGuard({ ...base, channel: "production", previewCommits: ["0000000", "9ededbe9b5570d6d0000"] }).ok).toBe(true);
  });
});

describe("native file check", () => {
  const app = { expo: { version: "1.9.3", ios: { buildNumber: "17" }, android: { versionCode: 15, package: "au.fintex.multies" }, plugins: ["expo-router"] } };

  it("ignores screens, tests and docs", () => {
    expect(nativeChanges(["src/app/(tabs)/settings.tsx", "__tests__/x.test.ts", "docs/OTA.md"], null, null)).toEqual([]);
  });

  it("flags plugins, native folders and the fingerprint config", () => {
    expect(nativeChanges(["plugins/x.js", "android/app/build.gradle", "ios/Podfile", "fingerprint.config.js"], null, null)).toEqual([
      "plugins/x.js", "android/app/build.gradle", "ios/Podfile", "fingerprint.config.js",
    ]);
  });

  it("ignores version number changes in app.json but flags anything else", () => {
    const bumped = { expo: { ...app.expo, version: "1.9.4", ios: { buildNumber: "18" }, android: { ...app.expo.android, versionCode: 16 } } };
    expect(nativeChanges(["app.json"], { before: app, after: bumped }, null)).toEqual([]);
    const plugin = { expo: { ...app.expo, plugins: ["expo-router", "expo-camera"] } };
    expect(nativeChanges(["app.json"], { before: app, after: plugin }, null)).toEqual(["app.json"]);
  });

  it("flags new dependencies in package.json but not new scripts", () => {
    const before = { scripts: { test: "jest" }, dependencies: { expo: "~58.0.17" } };
    expect(nativeChanges(["package.json"], null, { before, after: { ...before, scripts: { test: "jest", x: "y" } } })).toEqual([]);
    expect(nativeChanges(["package.json"], null, { before, after: { ...before, dependencies: { expo: "~58.0.17", "expo-camera": "~58.0.1" } } }))
      .toEqual(["package.json (dependencies)"]);
  });
});

describe("bundle env", () => {
  it("bundles each channel with the same API host as its build profile", () => {
    expect(bundleEnv(eas, "production")).toEqual({ EXPO_PUBLIC_API_BASE: "https://multies.si", EXPO_PUBLIC_FEATURE_PUSH_SERVER: "1" });
    expect(bundleEnv(eas, "preview").EXPO_PUBLIC_API_BASE).toBe("https://multies.si");
    expect(bundleEnv(eas, "development").EXPO_PUBLIC_API_BASE).toBe("https://preview.multies.si");
    expect(() => bundleEnv(eas, "nope")).toThrow(/No build profile/);
  });
});

describe("reading the preview branch from EAS", () => {
  it("takes the update groups from update:list and the commits from update:view", () => {
    const list = { name: "preview", currentPage: [
      { branch: "preview", group: "4c10af8c", platforms: "ios" },
      { branch: "preview", group: "dc7ed512", platforms: "android" },
      { branch: "preview", group: "4c10af8c", platforms: "ios" },
    ] };
    expect(groupIdsFromList(list)).toEqual(["4c10af8c", "dc7ed512"]);
    expect(groupIdsFromList({})).toEqual([]);
    const views = [[{ group: "4c10af8c", gitCommitHash: "266dbef802de" }], [{ group: "dc7ed512", gitCommitHash: "266dbef802de" }, { group: "x" }]];
    expect(commitsFromViews(views)).toEqual(["266dbef802de", "266dbef802de"]);
  });
});

describe("R29b rollout helpers", () => {
  it("refuses to publish when What's new is out of date with the changelog", () => {
    const r = evaluateGuard({ ...base, whatsNewCurrent: false });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/What's new/);
    expect(evaluateGuard({ ...base, whatsNewCurrent: true }).ok).toBe(true);
  });

  it("finds the newest group per platform (each platform has its own runtime version)", () => {
    const list = { currentPage: [
      { group: "g-ios-new", platforms: "ios", runtimeVersion: "e184", message: "\"R29b\" (1 minute ago by multies)", isRollBackToEmbedded: false },
      { group: "g-and-new", platforms: "android", runtimeVersion: "e5a5", message: "x" },
      { group: "g-ios-old", platforms: "ios", runtimeVersion: "e184" },
    ] };
    expect(latestGroupsByPlatform(list).map((g: { platform: string; group: string }) => [g.platform, g.group])).toEqual([["ios", "g-ios-new"], ["android", "g-and-new"]]);
    expect(latestGroupsByPlatform(list)[0].message).toBe("R29b");
    expect(latestGroupsByPlatform({ currentPage: [{ group: "both", platforms: "android, ios" }] }).map((g: { platform: string }) => g.platform)).toEqual(["android", "ios"]);
  });

  it("reads a group's rollout percentage", () => {
    expect(rolloutOf([{ id: "u", rolloutPercentage: 10 }])).toBe(10);
    expect(rolloutOf([{ id: "u", rolloutPercentage: 100 }])).toBeNull();
    expect(rolloutOf([{ id: "u" }])).toBeNull();
  });

  it("parses flags", () => {
    expect(parseFlags(["50", "--rollout", "10", "--critical", "--message", "Fix"])).toEqual({ _: ["50"], rollout: "10", critical: true, message: "Fix" });
  });

  it("wires every release command into npm", () => {
    const pkg = require("../package.json");
    for (const s of ["ota:preview", "ota:production", "ota:check", "ota:health", "ota:promote", "ota:rollback", "ota:status", "whats-new"]) expect(pkg.scripts[s]).toBeTruthy();
  });

  it("keeps the OTA client on modules the store build already has (no native change)", () => {
    const dir = join(__dirname, "..", "src", "lib", "ota");
    const pkg = require("../package.json");
    const allowed = new Set(["react", "react-native", "expo-updates", ...Object.keys(pkg.dependencies)]);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/from "([^"./@][^"]*|@[^/"]+\/[^"]+)"/g)) {
        const name = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
        if (name.startsWith("@/")) continue;
        expect([f, allowed.has(name)]).toEqual([f, true]);
      }
    }
  });
});
