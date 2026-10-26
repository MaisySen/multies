import { JS_VERSION, currentVersionFacts, updateDetail, versionLabel, type VersionFacts } from "@/lib/app-version";

const base: VersionFacts = { jsVersion: "1.9.3", nativeVersion: "1.9.3", nativeBuild: "17", embedded: true, updateId: null, channel: "production" };

describe("version line in Settings", () => {
  it("shows the store version and build for the built in bundle", () => {
    expect(versionLabel(base)).toBe("Multies 1.9.3 (17)");
    expect(updateDetail(base)).toBeNull();
  });

  it("marks a newer JavaScript version from an update as OTA", () => {
    const f = { ...base, jsVersion: "1.9.4", embedded: false, updateId: "0193f2aa-1111-7222-8333-444455556666" };
    expect(versionLabel(f)).toBe("Multies 1.9.4 (OTA)");
    expect(updateDetail(f)).toBe("Update 0193f2aa, channel production, store build 1.9.3 (17)");
  });

  it("keeps the plain version when an update did not change the number", () => {
    const f = { ...base, embedded: false, updateId: "abcdef0123456789" };
    expect(versionLabel(f)).toBe("Multies 1.9.3");
  });

  it("treats a launch without an update id as the built in bundle", () => {
    expect(versionLabel({ ...base, jsVersion: "2.0.0", embedded: false, updateId: null })).toBe("Multies 1.9.3 (17)");
  });

  it("falls back safely when native facts are missing", () => {
    expect(versionLabel({ ...base, nativeVersion: null, nativeBuild: null })).toBe("Multies 1.0.0");
  });

  it("reads the running app without throwing in tests", () => {
    const f = currentVersionFacts();
    expect(f.jsVersion).toBe(JS_VERSION);
    expect(typeof f.embedded).toBe("boolean");
  });
});
