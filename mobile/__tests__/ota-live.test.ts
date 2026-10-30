const { liveIos, liveAndroid, checkRuntimes, manifestIdFrom, parseRuntimeOverride } = require("../scripts/ota-live");

const RT110I = "fe703a98e9c589973da00970bfe6a3245f336a96";
const RT110A = "5c9046a2b2722bcdb48711f629fb4a38c335e78e";
const RT193I = "e184c142208d3b3fae34511c791824950b768f8a";
const RT193A = "e5a5bb6ce563a5072e021a35eb0966285dc7af8a";

const asc = [
  { buildNumber: "20", version: "1.10.0", processingState: "VALID", expired: false },
  { buildNumber: "17", version: "1.9.3", processingState: "VALID", expired: true },
];
const eas = [
  { platform: "IOS", appVersion: "1.10.0", appBuildVersion: "20", status: "FINISHED", runtime: { version: RT110I }, updateChannel: { name: "production" }, gitCommitHash: "3c232cb" },
  { platform: "IOS", appVersion: "1.9.3", appBuildVersion: "17", status: "FINISHED", runtime: { version: RT193I }, updateChannel: { name: "production" } },
];
const tracks = { tracks: [
  { track: "internal", releases: [{ name: "1.10.0 (16)", versionCodes: ["16"], status: "completed" }] },
  { track: "alpha", releases: [{ name: "1.8.1 (10)", versionCodes: ["10"], status: "completed" }] },
] };
const record = { builds: { "16": { version: "1.10.0", runtimeVersion: RT110A, channel: "production" }, "15": { version: "1.9.3", runtimeVersion: RT193A } } };

describe("ota-publish live store builds", () => {
  const live = { ios: liveIos(asc, eas), android: liveAndroid(tracks, record) };

  it("reads the newest live builds and skips expired TestFlight builds", () => {
    expect(live.ios.map((b) => b.build)).toEqual([20]);
    expect(live.ios[0].runtimeVersion).toBe(RT110I);
    expect(live.android.map((b) => b.build)).toEqual([16, 10]);
    expect(live.android[1].updatable).toBe(false);
  });

  it("passes when the code matches the live 1.10.0 runtimes", () => {
    const r = checkRuntimes({ live, current: { ios: RT110I, android: RT110A }, channel: "production" });
    expect(r.ok).toBe(true);
    expect(r.targets.map((t) => t.build).sort()).toEqual([16, 20]);
  });

  it("refuses the 1.9.13 publish (1.9.3 runtimes) while phones run 1.10.0", () => {
    const r = checkRuntimes({ live, current: { ios: RT193I, android: RT193A }, channel: "production" });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toMatch(/would never get this update/);
  });

  it("refuses when Play has a version code with no recorded runtime", () => {
    const t2 = { tracks: [{ track: "internal", releases: [{ versionCodes: ["17"], status: "completed" }] }] };
    const r = checkRuntimes({ live: { ios: live.ios, android: liveAndroid(t2, record) }, current: { ios: RT110I, android: RT110A } });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/versionCode 17/);
  });

  it("refuses when no live build is found", () => {
    const r = checkRuntimes({ live: { ios: [], android: live.android }, current: { ios: RT110I, android: RT110A } });
    expect(r.ok).toBe(false);
  });

  it("reads the update id from a multipart manifest", () => {
    const ct = "multipart/mixed; boundary=-----B";
    const body = '-------B\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n{"id":"abc","runtimeVersion":"x"}\r\n-------B--';
    expect(manifestIdFrom(body, ct)).toBe("abc");
    expect(manifestIdFrom('{"id":"def"}', "application/json")).toBe("def");
  });

  it("parses the drill runtime flag", () => {
    expect(parseRuntimeOverride("ios=a,android=b")).toEqual({ ios: "a", android: "b" });
  });
});
