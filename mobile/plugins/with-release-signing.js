/**
 * Config plugin: keeps Android release signing and the Play target SDK in the generated android/
 * project, so `npx expo prebuild --clean` never loses them.
 *
 * Release builds are signed with the upload key named by four values, read from Gradle properties
 * (for example ~/.gradle/gradle.properties) or from environment variables of the same name:
 *   MYMAIL_UPLOAD_STORE_FILE      absolute path to the .jks file
 *   MYMAIL_UPLOAD_STORE_PASSWORD
 *   MYMAIL_UPLOAD_KEY_ALIAS
 *   MYMAIL_UPLOAD_KEY_PASSWORD
 * None of them ever lives in this repo. When they are missing, a local release build falls back to
 * the debug key and says so; pass -PmymailRequireUploadKey=true to make that an error instead.
 * EAS Build signs with its own credentials and ignores this block.
 */
const { withAppBuildGradle, withProjectBuildGradle } = require("expo/config-plugins");

const TARGET_SDK = 36; // Google Play: new apps and updates target API 36 from 31 August 2026.
const COMPILE_SDK = 37; // AndroidX libraries in Expo SDK 58 need compileSdk 37 to build (checkAarMetadata). Play only rules on the target level.
const MARK = "// mymail-release-signing";

const SIGNING = `
    ${MARK}
    def mymailProp = { String name -> (findProperty(name) ?: System.getenv(name)) as String }
    def mymailStoreFile = mymailProp('MYMAIL_UPLOAD_STORE_FILE')
    def mymailHasUploadKey = mymailStoreFile && file(mymailStoreFile).exists() && mymailProp('MYMAIL_UPLOAD_STORE_PASSWORD') && mymailProp('MYMAIL_UPLOAD_KEY_ALIAS') && mymailProp('MYMAIL_UPLOAD_KEY_PASSWORD')
    if (!mymailHasUploadKey && (findProperty('mymailRequireUploadKey') ?: 'false').toBoolean()) {
        throw new GradleException("MyMail upload key not found. Set MYMAIL_UPLOAD_STORE_FILE, MYMAIL_UPLOAD_STORE_PASSWORD, MYMAIL_UPLOAD_KEY_ALIAS and MYMAIL_UPLOAD_KEY_PASSWORD (see docs/release.md).")
    }
`;

const RELEASE_CONFIG = `
        release {
            if (mymailHasUploadKey) {
                storeFile file(mymailStoreFile)
                storePassword mymailProp('MYMAIL_UPLOAD_STORE_PASSWORD')
                keyAlias mymailProp('MYMAIL_UPLOAD_KEY_ALIAS')
                keyPassword mymailProp('MYMAIL_UPLOAD_KEY_PASSWORD')
            }
            enableV2Signing true
            enableV3Signing true
        }`;

function applySigning(src) {
  if (src.includes(MARK)) return src;
  let out = src.replace(/\n(\s*)signingConfigs \{/, (m) => `\n${SIGNING}${m}`);
  // Add signingConfigs.release after the debug config.
  out = out.replace(/(signingConfigs \{\s*debug \{[^}]*\})/, `$1${RELEASE_CONFIG}`);
  // Point the release build type at it.
  out = out.replace(/(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/, (_m, head) =>
    `${head}if (mymailHasUploadKey) {\n                signingConfig signingConfigs.release\n            } else {\n                logger.warn("MyMail: no upload key set, this release build is signed with the debug key and Google Play will refuse it.")\n                signingConfig signingConfigs.debug\n            }`);
  if (!out.includes("signingConfig signingConfigs.release")) throw new Error("with-release-signing: app/build.gradle did not have the expected shape");
  return out;
}

function applyTargetSdk(src) {
  if (src.includes("mymail-target-sdk")) return src;
  return src.replace(/apply plugin: "expo-root-project"/, `ext { targetSdkVersion = ${TARGET_SDK}; compileSdkVersion = ${COMPILE_SDK} } // mymail-target-sdk\napply plugin: "expo-root-project"`);
}

module.exports = function withReleaseSigning(config) {
  config = withAppBuildGradle(config, (c) => { c.modResults.contents = applySigning(c.modResults.contents); return c; });
  config = withProjectBuildGradle(config, (c) => { c.modResults.contents = applyTargetSdk(c.modResults.contents); return c; });
  return config;
};
module.exports.applySigning = applySigning;
module.exports.applyTargetSdk = applyTargetSdk;
module.exports.TARGET_SDK = TARGET_SDK;
module.exports.COMPILE_SDK = COMPILE_SDK;
