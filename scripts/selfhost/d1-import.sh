#!/usr/bin/env bash
# Moves data across from Cloudflare D1 into this computer's Multies.
#   scripts/selfhost/d1-import.sh                     production (D1 "mymail-au")
#   scripts/selfhost/d1-import.sh mymail-staging --env staging
#   scripts/selfhost/d1-import.sh --sql import/file.sql   (an export you already have)
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env (D1 read access); remove them afterwards.
# Multies stops while the import runs; the old database is kept as /data/mymail.db.before-<time>.
set -euo pipefail
cd "$(dirname "$0")/../.."
DC=(docker compose -f docker-compose.selfhost.yml)
env_value() { grep -E "^$1=" .env | head -n1 | cut -d= -f2-; }

mkdir -p import
if [ "${1:-}" = "--sql" ]; then
  SQL="${2:?Usage: d1-import.sh --sql import/file.sql}"
  case "$SQL" in import/*) ;; *) cp "$SQL" import/ && SQL="import/$(basename "$SQL")";; esac
else
  DB="${1:-mymail-au}"; shift || true
  SQL="import/$DB-$(date +%Y%m%d-%H%M%S).sql"
  echo "== exporting $DB from Cloudflare (read only)"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp --env-file .env -v "$PWD:/w" -w /w node:22-bookworm-slim \
    npx -y wrangler@4 d1 export "$DB" --remote --output="$SQL" "$@"
fi
echo "== importing $SQL"
"${DC[@]}" stop mymail
"${DC[@]}" --profile tools run --rm --no-deps tools import "/$SQL" /data/mymail.db
"${DC[@]}" --profile tools run --rm --no-deps tools summary /data/mymail.db | grep -E "^(users|organizations|mailboxes|messages|tasks) "
"${DC[@]}" up -d mymail
echo "Done. Sign in with the same email and password as before."
