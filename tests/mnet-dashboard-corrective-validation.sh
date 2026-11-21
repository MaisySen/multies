#!/bin/bash
set -euo pipefail
mnet=${1:?Exact Mnet corrective source required}
multies=${2:?Companion source with lockfile dependencies required}
cd "$multies"
MNET_NATIVE_REPO="$mnet" node node_modules/vitest/vitest.mjs run tests/mnet-dashboard-client-order.test.ts
# Each script run creates a separate disposable native/browser environment.
# No failed attempt is silently retried. Original receipt durations are unchanged.
for run in 1 2 3 4;do
 printf 'Explicit expiry observation %s of4\n' "$run"
 MNET_DEVELOPMENT_SETUP_CASE=network-tcp-expiry bash tests/mnet-live-dashboard-validation.sh "$mnet" "$multies"
done
MNET_DEVELOPMENT_SETUP_CASE=network-tcp-cancel bash tests/mnet-live-dashboard-validation.sh "$mnet" "$multies"
