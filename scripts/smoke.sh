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
# QUAL1 (audit row 36): /api/health answers only { ok, db }; the release serving is on /api/config.
HEALTH=""
CONFIG=""
for i in $(seq 1 24); do
  if HEALTH=$(curl -fsS "$BASE/api/health") && echo "$HEALTH" | grep -q '"ok":true' \
     && { [ -z "$EXPECT_RELEASE" ] || { CONFIG=$(curl -fsS "$BASE/api/config") && echo "$CONFIG" | grep -q "\"release\":\"$EXPECT_RELEASE"; }; }; then
    break
  fi
  sleep 5
done
echo "health: ${HEALTH:-none}"
echo "$HEALTH" | grep -q '"ok":true' || fail "health is not ok"
echo "$HEALTH" | grep -q '"db":"ok"' || fail "database is not fully migrated (health says db is not ok)"
if [ -n "$EXPECT_RELEASE" ]; then
  echo "$CONFIG" | grep -q "\"release\":\"$EXPECT_RELEASE" || fail "expected release $EXPECT_RELEASE (from /api/config)"
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

# 5. R39: "Try the live demo" opens a demo workspace (production has password sign up off, which once broke it).
# One demo a run (it purges itself after a day). SMOKE_DEMO=0 skips it; a "resting for today" answer (503,
# the daily demo cap or the D1 write budget) is a warning, any other answer is a failure.
if [ "${SMOKE_DEMO:-1}" != "0" ]; then
  JAR=$(mktemp); trap 'rm -f "$JAR" "$JAR.check" "$JAR.tok"' EXIT
  # R74 (MB-271): our own check's demo is marked, so it never uses up the visitors' daily demos.
  # R76 (security review M2): it carries a signed header made fresh here (v1.<time>.<HMAC>, good five minutes, staging
  # and production tokens differ), written to a mode 600 header file by check-header.mjs; the token never travels.
  CHECK_HDR=()
  if node "$(dirname "$0")/creds.mjs" run QA_CHECK_TOKEN,QA_CHECK_TOKEN_STAGING -- node "$(dirname "$0")/check-header.mjs" "$BASE" "$JAR.check" >/dev/null 2>&1 && [ -s "$JAR.check" ]; then
    CHECK_HDR=(-H "@$JAR.check")
  fi
  code=$(curl -s -o "$JAR.body" -w '%{http_code}' -c "$JAR" -X POST -H "origin: $BASE" -H 'content-type: application/json' "${CHECK_HDR[@]}" -d '{}' "$BASE/api/account/demo")
  if [ "$code" = "503" ] && grep -q demo_paused "$JAR.body"; then
    echo "smoke warning: the demo is resting for today (503 demo_paused)"
  else
    [ "$code" = "201" ] || [ "$code" = "200" ] || fail "demo should open (201), got $code: $(head -c 200 "$JAR.body")"
    ME=$(curl -fsS -b "$JAR" "$BASE/api/account/me") || fail "demo session did not sign in"
    echo "$ME" | grep -q '"isDemo":true' || fail "demo did not land in the demo workspace"
    echo "demo: opened ($code) and landed in the demo workspace"
  fi
  rm -f "$JAR.body"
fi

# 6. Sign in mail (27 Oct 2026): on production the identity provider sends the confirmation and password reset
# emails through its own SMTP setting, which a revoked key once broke for a day while everything above passed.
# Production only (staging shares the tenant): no failed email logged in the last 30 minutes, and one real
# confirmation email accepted by the email provider (a throwaway user at our test inbox, deleted after).
# SMOKE_AUTH_MAIL=0 skips it. Needs ~/.multies-secrets/auth0-multies.json (domain, client id) and RESEND_API_KEY plus
# AUTH0_TAB_MGMT_CLIENT_SECRET via creds.mjs (the store every rotation updates);
# without them it is a warning, never a pass. docs/runbooks/auth-mail.md.
case "$BASE" in
  https://multies.si|https://app.multies.si|https://mymail.mymail-app.workers.dev) PROD_BASE=1 ;;
  *) PROD_BASE=0 ;;
esac
if [ "${SMOKE_AUTH_MAIL:-1}" != "0" ] && [ "$PROD_BASE" = "1" ]; then
  HERE=$(cd "$(dirname "$0")" && pwd)
  set +e
  node "$HERE/creds.mjs" run RESEND_API_KEY,AUTH0_TAB_MGMT_CLIENT_SECRET -- node "$HERE/auth-mail-check.mjs" --probe --minutes 30 2>&1 | grep -v -i 'warning\|trace-warn'
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" = "1" ]; then fail "sign in mail is broken (confirmation or reset emails are not going out)"; fi
  if [ "$rc" != "0" ]; then echo "smoke warning: the sign in mail check could not run here (exit $rc)"; fi
fi

echo "smoke ok: $BASE"
