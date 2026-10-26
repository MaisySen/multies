/**
 * Fingerprint (runtime version) settings for EAS Update. The "balanced" preset plus: npm scripts
 * never change the native app, so editing them (for example the ota:* scripts) must not change the
 * runtime version. See docs/OTA.md.
 */
const { SourceSkips } = require("expo/fingerprint");

/** @type {import("expo/fingerprint").Config} */
module.exports = {
  sourceSkips:
    SourceSkips.PackageJsonAndroidAndIosScriptsIfNotContainRun |
    SourceSkips.PackageJsonScriptsAll |
    SourceSkips.ExpoConfigVersions |
    SourceSkips.ExpoConfigRuntimeVersionIfString |
    SourceSkips.EasJson |
    SourceSkips.Easignore |
    SourceSkips.AutolinkingConfigPaths,
};
