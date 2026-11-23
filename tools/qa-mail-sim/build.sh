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
xcodebuild -version > "$RUNNER_TEMP/mail-xcode-version.txt"
if ! grep -Fqx 'Xcode 26.4.1' "$RUNNER_TEMP/mail-xcode-version.txt"; then
  printf '%s\n' 'The pinned Xcode version did not match the runner.'
  head -n 1 "$RUNNER_TEMP/mail-xcode-version.txt"
  exit 2
fi
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
safe_xcode() {
  local log="$RUNNER_TEMP/xcode.log" st=0
  "$@" >"$log" 2>&1 || st=$?
  if (( st == 0 )); then return 0; fi
  printf 'Xcode exited with status %s.\n' "$st"
  python3 - "$log" <<'PYDIAG'
from collections import Counter
from pathlib import Path
import re, sys
patterns = {
 'failed command': r'(PhaseScriptExecution|CompileSwift|SwiftCompile|CompileC|Libtool|Ld|CodeSign)\b.*\(in target [\'\"]([A-Za-z0-9_. -]{1,65})[\'\"]',
 'shell tool missing': r'(?:command not found|No such file or directory)',
 'file missing': r'(?:build input file cannot be found|header not found|no such file or module|file not found)',
 'missing module': r"(?:no such module|could not build module) ['\"]([A-Za-z][A-Za-z0-9_.]{0,60})['\"]",
 'build-script sandbox': r'Sandbox: .*deny',
 'result architecture': r'(?:built for|building for|architecture|arch)\b.*(?:iOS Simulator|arm64|x86_64)',
 'link error': r'(?:undefined symbols|duplicate symbol|linker command failed)',
 'signing error': r'(?:requires a provisioning profile|Signing for .* requires a development team|codesign.*failed)',
 'scheme or workspace': r'(?:does not contain a scheme|does not exist|Unable to find a destination|Could not find scheme)',
 'other compiler error': r'(?:fatal )?error:',
}
seen=Counter(); detail=[]
with Path(sys.argv[1]).open(errors='replace') as f:
 for raw in f:
  l=re.sub(r'\x1b\[[0-9;]*m','',raw)
  if not re.search(r'error:|\(in target|command not found|undefined symbols|Sandbox:|No such file|requires a development team',l,re.I):continue
  for k,p in patterns.items():
   m=re.search(p,l,re.I)
   if m:
    seen[k]+=1
    if k in {'failed command','missing module'} and tuple(m.groups()) not in detail:
     safe=tuple(m.groups()); detail.append(safe)
    if k not in {'failed command','other compiler error'}:break
  # Only short compiler messages from local project sources, stripped of paths and credentials.
  if len(detail)<12 and 'error:' in l and not re.search(r'(?i)https?://|https?\\:|\b(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|PRIVATE KEY|API KEY|provisioning|team id)\b|\.env\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[a-zA-Z0-9_\-+/]{33,}',l):
   sub=l.split('error:',1)[-1].strip(); sub=re.sub(r'/(?:[^\s/]+/)+([^\s/]+)',r'<path>/\1',sub); sub=re.sub(r'[\x00-\x1F]','',sub)
   if 0<len(sub)<=185 and re.fullmatch(r"[\w .,:;()\]\[/<>_+{}'`\"\-*!?=\\]+",sub):
    line=('compiler',sub)
    if line not in detail:detail.append(line)
print('Build diagnostics:', ', '.join(f'{k}={v}' for k,v in seen.items()) or 'no recognised error line emitted')
for d in detail[:12]: print('Diagnostic:', ' / '.join(d))
PYDIAG
  echo 'Blocked at xcode.'
  return 2
}
safe_xcode xcodebuild -workspace Multies.xcworkspace -scheme Multies -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= COMPILER_INDEX_STORE_ENABLE=NO
app='build/Build/Products/Release-iphonesimulator/Multies.app'
[[ -s "$app/main.jsbundle" && -f "$app/Info.plist" ]] || { echo 'Missing simulator application or JavaScript bundle.'; exit 2; }
exec_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist")"
[[ "$exec_name" =~ ^[a-zA-Z0-9_.-]+$ && -f "$app/$exec_name" ]] || { echo 'Missing simulator executable.'; exit 2; }
xcrun lipo -verify_arch arm64 "$app/$exec_name" || { echo 'Simulator executable does not contain arm64.'; exit 2; }
printf '%s\n' 'Unsigned simulator fixture built.'
