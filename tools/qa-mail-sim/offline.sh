#!/usr/bin/env bash
# Dedicated ephemeral GitHub-hosted VM only. Never use on a shared Mac.
set -euo pipefail
umask 077
export LC_ALL=C
export DEVELOPER_DIR=/Applications/Xcode_26.4.1.app/Contents/Developer
export JAVA_HOME="${JAVA_HOME_21_arm64:?Missing Java 21}"
export PATH="$JAVA_HOME/bin:$PATH"
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "${RUNNER_OS:-}" == macOS ]]
app="${1:?missing fixture .app}"
dev=''
armed=0
was_enabled=0
pf=/sbin/pfctl
quiet="$RUNNER_TEMP/mail-offline.log"
cleanup() {
  local rc=$?
  trap - EXIT
  # Never reconnect with the test process/simulator running. Leave offline on cleanup failure.
  if [[ -n "$dev" ]]; then
    xcrun simctl shutdown "$dev" >>"$quiet" 2>&1 || true
    if ! xcrun simctl list devices booted -j | python3 -c 'import json,sys; assert not any(d["state"] == "Booted" for ds in json.load(sys.stdin)["devices"].values() for d in ds)'; then
      echo 'Simulator shutdown could not be verified; not restoring connectivity.'; exit 2
    fi
  fi
  if (( armed )); then
    sudo -n "$pf" -f /etc/pf.conf >>"$quiet" 2>&1 || exit 2
    if (( ! was_enabled )); then sudo -n "$pf" -d >>"$quiet" 2>&1 || exit 2; fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 2' HUP INT TERM

# Start with no existing simulator process; create/boot happens only under the deny policy.
if ! xcrun simctl list devices booted -j | python3 -c 'import json,sys; assert not any(d["state"] == "Booted" for ds in json.load(sys.stdin)["devices"].values() for d in ds)'; then
  echo 'The VM is not disposable and idle.'; exit 2
fi
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
maestro --version >"$quiet" 2>&1 || { echo 'Maestro CLI not available.'; exit 2; }
# Public, numeric TCP canary only: no HTTP, credentials, DNS, or application/customer request.
ipv4=1.1.1.1
ipv6=2606:4700:4700::1111
probe() { python3 -c 'import socket, sys; socket.create_connection((sys.argv[1],443), timeout=2).close()' "$1" >>"$quiet" 2>&1; }
probe "$ipv4" || { echo 'IPv4 isolation canary could not establish a baseline.'; exit 2; }
v6_reachable=0
if probe "$ipv6"; then v6_reachable=1; fi
info="$(sudo -n "$pf" -s info 2>>"$quiet")"
if grep -q '^Status: Enabled' <<< "$info"; then was_enabled=1; else grep -q '^Status: Disabled' <<< "$info"; fi
cat > "$RUNNER_TEMP/mail-offline.pf" <<'PF'
set skip on lo0
block drop quick inet all label "mail_offline_ipv4"
block drop quick inet6 all label "mail_offline_ipv6"
PF
sudo -n "$pf" -nf "$RUNNER_TEMP/mail-offline.pf" >>"$quiet" 2>&1
armed=1
sudo -n "$pf" -f "$RUNNER_TEMP/mail-offline.pf" >>"$quiet" 2>&1
if (( ! was_enabled )); then sudo -n "$pf" -e >>"$quiet" 2>&1; fi
# A pre-existing connection must not be able to bypass the new filter through PF state.
sudo -n "$pf" -F states >>"$quiet" 2>&1
assert_rules() {
  local rules status expected
  status="$(sudo -n "$pf" -s info 2>>"$quiet")" || return 1
  grep -q '^Status: Enabled' <<< "$status" || return 1
  rules="$(sudo -n "$pf" -sr 2>>"$quiet")" || return 1
  expected=$'block drop quick inet all label "mail_offline_ipv4"\nblock drop quick inet6 all label "mail_offline_ipv6"'
  [[ "$rules" == "$expected" ]]
}
verify_block() {
  local before after ip="$1" label="$2"
  before="$(sudo -n "$pf" -s labels 2>>"$quiet" | awk -v label="$label" '$1 == label {print $3}')" || return 1
  if probe "$ip"; then return 1; fi
  after="$(sudo -n "$pf" -s labels 2>>"$quiet" | awk -v label="$label" '$1 == label {print $3}')" || return 1
  [[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ && "$after" -gt "$before" ]]
}
assert_rules && verify_block "$ipv4" mail_offline_ipv4 || { echo 'Egress enforcement not verified; test not started.'; exit 2; }
if (( v6_reachable )); then
  verify_block "$ipv6" mail_offline_ipv6 || { echo 'IPv6 egress enforcement not verified; test not started.'; exit 2; }
fi
python3 - <<'PY'
import socket
for host in ('127.0.0.1', '::1'):
    with socket.create_server((host, 0), family=socket.AF_INET6 if ':' in host else socket.AF_INET) as server:
        server.settimeout(2)
        with socket.create_connection(server.getsockname()[:2], timeout=2) as client, server.accept()[0] as peer:
            client.sendall(b'x')
            assert peer.recv(1) == b'x'
PY

dev="$(xcrun simctl create 'iPhone 17 Mail Smoke' com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-4 2>>"$quiet")"
xcrun simctl boot "$dev" >>"$quiet" 2>&1
xcrun simctl bootstatus "$dev" -b >>"$quiet" 2>&1
xcrun simctl spawn "$dev" defaults write NSGlobalDomain AppleLanguages -array en >>"$quiet" 2>&1
xcrun simctl spawn "$dev" defaults write NSGlobalDomain AppleLocale en_US >>"$quiet" 2>&1
xcrun simctl ui "$dev" appearance light >>"$quiet" 2>&1
assert_rules && verify_block "$ipv4" mail_offline_ipv4 || { echo 'Egress enforcement not verified after simulator boot; test not started.'; exit 2; }
if (( v6_reachable )); then
  verify_block "$ipv6" mail_offline_ipv6 || { echo 'IPv6 egress enforcement not verified after simulator boot; test not started.'; exit 2; }
fi
rc=0
python3 "$GITHUB_WORKSPACE/tools/qa-mail-sim/fixture/run.py" --offline-disposable-simulator "$dev" "$app" || rc=$?
assert_rules || { echo 'Egress policy not observed at the end; no valid result.'; exit 2; }
exit "$rc"
