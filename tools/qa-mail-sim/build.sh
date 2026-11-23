#!/usr/bin/env bash
set -euo pipefail
umask 077
fixture="$GITHUB_WORKSPACE/tools/qa-mail-sim/fixture"
export DEVELOPER_DIR=/Applications/Xcode_26.4.1.app/Contents/Developer
export CI=1 EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1 COCOAPODS_DISABLE_STATS=true EXPO_NO_GIT_STATUS=1
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export JAVA_HOME="${JAVA_HOME_21_arm64:?Missing Java 21}"
export PATH="$JAVA_HOME/bin:$PATH"
[[ "$(uname -m)" == arm64 && "$(node -v)" == v22.23.4 ]]
xcodebuild -version | grep -qx 'Xcode 26.4.1'
xcrun simctl list runtimes -j | python3 -c 'import json,sys; assert any(x["identifier"].endswith("iOS-26-4") and x["isAvailable"] for x in json.load(sys.stdin)["runtimes"])'
# Source is the exact mobile subtree in this dedicated private repository—not a network pull from another repository.
node "$fixture/prepare.mjs" "$GITHUB_WORKSPACE" "$RUNNER_TEMP/mail-fixture"
# Public pinned tool/template. The zip is the release asset, not a remote install script.
curl -qfsSL --retry 1 --max-time 180 -o "$RUNNER_TEMP/maestro.zip" \
  https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.12.1/maestro.zip
printf '%s  %s\n' 54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7 "$RUNNER_TEMP/maestro.zip" | shasum -a 256 -c --status
unzip -q "$RUNNER_TEMP/maestro.zip" -d "$RUNNER_TEMP/maestro-dist"
tool="$(find "$RUNNER_TEMP/maestro-dist" -path '*/bin/maestro' -type f -print)"
[[ -f "$tool" && -x "$tool" ]] || { echo 'Maestro CLI unavailable'; exit 2; }
printf '%s\n' "${tool%/*}" >> "$GITHUB_PATH"
curl -qfsS --max-time 25 -o "$RUNNER_TEMP/expo-template.tgz" \
  https://registry.npmjs.org/expo-template-bare-minimum/-/expo-template-bare-minimum-58.0.35.tgz
printf '%s' 'YW9njiXrFEBrSxHMZJzMW9/1ZgH46ZuY7IqxlYhQv9dxIEMVFUwAmcD29+WH7AofTII1FsfnTLC5DJ03HUo9xw==' | base64 -D > "$RUNNER_TEMP/template.digest"
openssl dgst -sha512 -binary "$RUNNER_TEMP/expo-template.tgz" | cmp -s "$RUNNER_TEMP/template.digest" -
cd "$RUNNER_TEMP/mail-fixture/mobile"
# No raw build logs in the public job; dependencies are fetched only during preparation.
quiet() { local label="$1"; shift; "$@" >"$RUNNER_TEMP/$label.log" 2>&1 || { printf 'Blocked at %s.\n' "$label"; exit 2; }; }
quiet npm npm ci --no-audit --no-fund --ignore-scripts
# Prebuild may rewrite package.json; Xcode/Metro must still use the pinned manifest and modules.
cp package.json "$RUNNER_TEMP/mail-package.json"
cp package-lock.json "$RUNNER_TEMP/mail-package-lock.json"
quiet prebuild ./node_modules/.bin/expo prebuild --platform ios --no-install --clean \
  --skip-dependency-update expo,react,react-native,expo-status-bar --template "$RUNNER_TEMP/expo-template.tgz"
cmp -s package-lock.json "$RUNNER_TEMP/mail-package-lock.json"
cp "$RUNNER_TEMP/mail-package.json" package.json
cd ios
quiet pods pod install
quiet xcode xcodebuild -workspace Multies.xcworkspace -scheme Multies -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -arch arm64 \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= COMPILER_INDEX_STORE_ENABLE=NO
[[ -f build/Build/Products/Release-iphonesimulator/Multies.app/main.jsbundle ]]
printf '%s\n' 'Unsigned simulator fixture built.'
