#!/bin/bash
# Source-review gate is deliberate; do not run as part of ordinary test discovery.
set -euo pipefail
: "${MNET_PAIR_EXECUTION_REVIEWED:?Independent source review and release required}"
[ "$MNET_PAIR_EXECUTION_REVIEWED" = 1 ] || exit 2
mnet=${1:?Mnet candidate source required}
multies=${2:?Multies candidate source with dependencies required}
run=$(mktemp -d /tmp/mnet-two-installed-validation.XXXXXX)
chmod 700 "$run"
xpid=
bpid=
cleanup(){
 if [ -n "$bpid" ];then
  if kill -0 "$bpid" 2>/dev/null;then kill "$bpid";fi
  wait "$bpid" || true
 fi
 if [ -n "$xpid" ];then
  if kill -0 "$xpid" 2>/dev/null;then kill "$xpid";fi
  wait "$xpid" || true
 fi
}
trap cleanup EXIT INT TERM
mkdir -p "$run/home/.local/share/applications" "$run/home/.config" "$run/app/bin"
# No silent go.mod relaxation. The source-required Go toolchain is a separate gate.
go -C "$mnet" build -race -tags mnet_enrollment_development -o "$run/app/bin/mnet-setup-development" ./cmd/mnet-setup-development
go -C "$mnet" build -race -tags mnet_enrollment_development -o "$run/app/bin/mnet-pair-development" ./cmd/mnet-pair-development
cat > "$run/home/.local/share/applications/mnet-disposable.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Mnet disposable development browser
Exec=/usr/bin/google-chrome --no-sandbox --no-first-run --ignore-certificate-errors --remote-debugging-port=0 --user-data-dir=$run/home/chrome %U
Terminal=false
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
DESKTOP
cat > "$run/home/.config/mimeapps.list" <<'MIME'
[Default Applications]
x-scheme-handler/http=mnet-disposable.desktop
x-scheme-handler/https=mnet-disposable.desktop
text/html=mnet-disposable.desktop
MIME
Xvfb -displayfd 3 -screen 0 1280x1000x24 3>"$run/display" >"$run/xvfb.log" 2>&1 &
xpid=$!
for i in $(seq 1 50);do if [ -s "$run/display" ];then break;fi;sleep .1;done
[ -s "$run/display" ] || { printf 'Owned Xvfb startup failed\n' >&2;exit 1; }
# Keep the browser a direct child too. Desktop URL opens reuse this exact
# owned profile, while cleanup can stop and join the original process.
DISPLAY=":$(cat "$run/display")" /usr/bin/google-chrome --no-sandbox --no-first-run --ignore-certificate-errors --remote-debugging-port=0 --user-data-dir="$run/home/chrome" about:blank >"$run/chrome.log" 2>&1 &
bpid=$!
for i in $(seq 1 100);do if [ -s "$run/home/chrome/DevToolsActivePort" ];then break;fi;sleep .05;done
[ -s "$run/home/chrome/DevToolsActivePort" ] || { printf 'Owned browser startup failed\n' >&2;exit 1; }
cd "$multies"
dbus-run-session -- env DISPLAY=":$(cat "$run/display")" GOPATH="$(go env GOPATH)" GOCACHE="$(go env GOCACHE)" HOME="$run/home" XDG_CONFIG_HOME="$run/home/.config" XDG_DATA_HOME="$run/home/.local/share" XDG_CURRENT_DESKTOP=GNOME GIO_USE_VFS=local MNET_DEVELOPMENT_SETUP_DEVTOOLS_FILE="$run/home/chrome/DevToolsActivePort" MNET_DEVELOPMENT_SETUP_BROWSER=1 MNET_DEVELOPMENT_SETUP_BINARY="$run/app/bin/mnet-setup-development" MNET_DEVELOPMENT_PAIR_BINARY="$run/app/bin/mnet-pair-development" MNET_NATIVE_REPO="$mnet" node node_modules/vitest/vitest.mjs run tests/mnet-two-installed-http.test.ts
printf 'Disposable validation root: %s\n' "$run"
