#!/bin/bash
set -euo pipefail
mnet=${1:?Mnet source required}
multies=${2:?Multies source with dependencies required}
run=$(mktemp -d /tmp/mnet-development-installed-validation.XXXXXX)
chmod 700 "$run"
xpid=
cleanup(){
 if [ -n "$xpid" ];then kill "$xpid" 2>/dev/null || true;wait "$xpid" 2>/dev/null || true;fi
}
trap cleanup EXIT INT TERM
mkdir -p "$run/home/.local/share/applications" "$run/home/.config" "$run/app/bin"
go -C "$mnet" build -race -tags mnet_enrollment_development -o "$run/app/bin/mnet-setup-development" ./cmd/mnet-setup-development
cat > "$run/home/.local/share/applications/mnet-disposable.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Mnet disposable development browser
Exec=/usr/bin/google-chrome --no-sandbox --no-first-run --ignore-certificate-errors --remote-debugging-port=0 --user-data-dir=$run/home/chrome %U
Terminal=false
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
EOF
cat > "$run/home/.config/mimeapps.list" <<'EOF'
[Default Applications]
x-scheme-handler/http=mnet-disposable.desktop
x-scheme-handler/https=mnet-disposable.desktop
text/html=mnet-disposable.desktop
EOF
Xvfb -displayfd 3 -screen 0 1280x1000x24 3>"$run/display" >"$run/xvfb.log" 2>&1 &
xpid=$!
for i in $(seq 1 50);do if [ -s "$run/display" ];then break;fi;sleep .1;done
cd "$multies"
dbus-run-session -- env DISPLAY=":$(cat "$run/display")" GOPATH="$(go env GOPATH)" GOCACHE="$(go env GOCACHE)" HOME="$run/home" XDG_CONFIG_HOME="$run/home/.config" XDG_DATA_HOME="$run/home/.local/share" XDG_CURRENT_DESKTOP=GNOME GIO_USE_VFS=local MNET_DEVELOPMENT_SETUP_DEVTOOLS_FILE="$run/home/chrome/DevToolsActivePort" MNET_DEVELOPMENT_SETUP_BROWSER=1 MNET_DEVELOPMENT_SETUP_BINARY="$run/app/bin/mnet-setup-development" MNET_NATIVE_REPO="$mnet" node node_modules/vitest/vitest.mjs run tests/mnet-standalone-installed.test.ts
sleep 2
printf 'Disposable development validation root: %s\n' "$run"
