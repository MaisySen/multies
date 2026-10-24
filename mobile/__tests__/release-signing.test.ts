/* The config plugin that keeps release signing and the target SDK through expo prebuild. */
const { applySigning, applyTargetSdk, TARGET_SDK } = require("../plugins/with-release-signing");

const GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"
            def enablePngCrunchInRelease = findProperty('android.enablePngCrunchInReleaseBuilds') ?: 'true'
            crunchPngs enablePngCrunchInRelease.toBoolean()
        }
    }
}
`;

describe("release signing plugin", () => {
  it("adds an upload key config read from properties or env and uses it for release", () => {
    const out: string = applySigning(GRADLE);
    expect(out).toContain("findProperty(name) ?: System.getenv(name)");
    expect(out).toMatch(/release \{\s*if \(mymailHasUploadKey\) \{\s*storeFile file\(mymailStoreFile\)/);
    expect(out).toContain("signingConfig signingConfigs.release");
    // Debug builds keep the debug key.
    expect(out).toMatch(/buildTypes \{\s*debug \{\s*signingConfig signingConfigs\.debug/);
    // No secret values in the file, only property names.
    expect(out).not.toMatch(/storePassword '[^']+'\s*\n\s*keyAlias 'mymail/);
  });

  it("runs once even when prebuild applies it twice", () => {
    const once = applySigning(GRADLE);
    expect(applySigning(once)).toBe(once);
  });

  it("pins the Play target SDK", () => {
    const root = 'buildscript {}\napply plugin: "expo-root-project"\n';
    const out: string = applyTargetSdk(root);
    expect(TARGET_SDK).toBeGreaterThanOrEqual(36);
    expect(out).toContain(`ext { targetSdkVersion = ${TARGET_SDK} }`);
    expect(applyTargetSdk(out)).toBe(out);
  });
});
