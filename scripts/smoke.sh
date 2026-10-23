#!/usr/bin/env bash
# Post-deploy smoke checks for one environment. Fails loudly on the first problem.
#   scripts/smoke.sh https://mymail-staging.mymail-app.workers.dev [expected-release]
set -euo pipefail
BASE="${1:?base URL}"
EXPECT_RELEASE="${2:-}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# 1. Health: database reachable and migrated, and the new release is the one serving.
# A deploy takes a few seconds to reach every Cloudflare location, so the old release can
# still answer at first: keep asking for up to two minutes until the expected one does.
HEALTH=""
for i in $(seq 1 24); do
  if HEALTH=$(curl -fsS "$BASE/api/health") && echo "$HEALTH" | grep -q '"ok":true' \
     && { [ -z "$EXPECT_RELEASE" ] || echo "$HEALTH" | grep -q "\"release\":\"$EXPECT_RELEASE"; }; then
    break
  fi
  sleep 5
done
echo "health: ${HEALTH:-none}"
echo "$HEALTH" | grep -q '"ok":true' || fail "health is not ok"
if [ -n "$EXPECT_RELEASE" ]; then
  echo "$HEALTH" | grep -q "\"release\":\"$EXPECT_RELEASE" || fail "expected release $EXPECT_RELEASE"
fi

# 2. The app shell renders with its security headers.
HEADERS=$(curl -fsS -D - -o /dev/null "$BASE/login")
echo "$HEADERS" | grep -qi '^content-security-policy:.*frame-ancestors' || fail "CSP missing on /login"
echo "$HEADERS" | grep -qi '^strict-transport-security:' || fail "HSTS missing"
echo "$HEADERS" | grep -qi '^x-content-type-options: nosniff' || fail "nosniff missing"

# 3. Public endpoints answer.
curl -fsS "$BASE/api/status" | grep -q '"overall"' || fail "status endpoint"
curl -fsS "$BASE/api/v1/openapi.json" | grep -q '"openapi"' || fail "OpenAPI spec"
curl -fsS "$BASE/.well-known/security.txt" | grep -q '^Contact:' || fail "security.txt"

# 4. Auth is protected and CSRF is enforced.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/account/me")
[ "$code" = "401" ] || fail "/api/account/me should be 401 signed out, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'origin: https://evil.example' -H 'content-type: application/json' -d '{}' "$BASE/api/domains")
[ "$code" = "403" ] || fail "cross-site POST should be 403, got $code"

echo "smoke ok: $BASE"
