#!/usr/bin/env bash
# First run of self-hosted MyMail (Linux and macOS). Safe to run again.
#   1. writes .env with strong secrets (only fills empty values)
#   2. builds the MyMail image
#   3. starts Stalwart in recovery mode, wires it to MyMail, restarts it normally
#   4. starts everything
set -euo pipefail
cd "$(dirname "$0")/../.."
DC=(docker compose -f docker-compose.selfhost.yml)
env_value() { grep -E "^$1=" .env | head -n1 | cut -d= -f2-; }

echo "== 1/4 .env"
if command -v node >/dev/null 2>&1; then node scripts/selfhost/gen-env.mjs
else docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/w" -w /w node:22-alpine node scripts/selfhost/gen-env.mjs; fi

echo "== 2/4 build (a few minutes the first time)"
"${DC[@]}" build mymail

echo "== 3/4 mail server"
SETUP_ADMIN="$(env_value STALWART_SETUP_ADMIN)"
export STALWART_RECOVERY_ADMIN="$SETUP_ADMIN"
STALWART_RECOVERY_MODE=1 "${DC[@]}" up -d --force-recreate stalwart
for i in $(seq 1 60); do
  if "${DC[@]}" --profile setup run --rm --no-deps --entrypoint node setup -e "fetch('http://stalwart:8080/').then(()=>process.exit(0),()=>process.exit(1))" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { echo "Stalwart did not start. See: docker compose -f docker-compose.selfhost.yml logs stalwart"; exit 1; }
  sleep 2
done
"${DC[@]}" --profile setup run --rm --no-deps setup
unset STALWART_RECOVERY_ADMIN
"${DC[@]}" up -d --force-recreate stalwart

echo "== 4/4 start"
"${DC[@]}" up -d
echo
echo "MyMail is starting at $(env_value APP_URL). Create your account there."
echo "Then add an inbound key (Settings, Inbound) to MYMAIL_INBOUND_KEYS in .env and run:"
echo "  docker compose -f docker-compose.selfhost.yml up -d mail-bridge"
