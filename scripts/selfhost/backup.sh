#!/usr/bin/env bash
# Backs up MyMail's database (online, while it runs), Stalwart's data and .env into
# backups/mymail-backup-<time>.tar.gz. Stalwart pauses for a few seconds while its data is copied;
# mail servers that try during that moment simply retry.
# The archive holds your mail and your secrets: keep it somewhere safe.
set -euo pipefail
cd "$(dirname "$0")/../.."
DC=(docker compose -f docker-compose.selfhost.yml)
env_value() { grep -E "^$1=" .env | head -n1 | cut -d= -f2-; }

TS="$(date +%Y%m%d-%H%M%S)"
WORK="backups/mymail-backup-$TS"
mkdir -p "$WORK"
"${DC[@]}" --profile tools run --rm --no-deps --user root tools backup /data/mymail.db "/$WORK/mymail.db"
"${DC[@]}" stop stalwart
"${DC[@]}" --profile tools run --rm --no-deps --user root -v mymail_stalwart-data:/stalwart:ro --entrypoint tar tools czf "/$WORK/stalwart-data.tar.gz" -C /stalwart . || { "${DC[@]}" start stalwart; exit 1; }
"${DC[@]}" start stalwart
cp .env "$WORK/env"
tar czf "$WORK.tar.gz" -C backups "mymail-backup-$TS"
rm -rf "$WORK"
echo "Backup written: $WORK.tar.gz"
