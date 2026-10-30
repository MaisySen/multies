#!/usr/bin/env bash
# Restores a backup made by backup.sh: scripts/selfhost/restore.sh backups/mymail-backup-<time>.tar.gz
# Stops Multies and Stalwart, puts the database and Stalwart's data back, starts them again.
# The database being replaced is kept beside it as mymail.db.before-<time>.
set -euo pipefail
ARCHIVE="${1:?Usage: scripts/selfhost/restore.sh backups/mymail-backup-<time>.tar.gz}"
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"
cd "$(dirname "$0")/../.."
DC=(docker compose -f docker-compose.selfhost.yml)
env_value() { grep -E "^$1=" .env | head -n1 | cut -d= -f2-; }

NAME="$(basename "$ARCHIVE" .tar.gz)"
mkdir -p backups/restore
tar xzf "$ARCHIVE" -C backups/restore
SRC="backups/restore/$NAME"
[ -f "$SRC/mymail.db" ] || { echo "$ARCHIVE does not look like a Multies backup."; exit 1; }
if [ "$(grep -E '^APP_SECRET=' "$SRC/env" | cut -d= -f2-)" != "$(env_value APP_SECRET)" ]; then
  echo "Note: APP_SECRET in this backup differs from .env. Encrypted keys need the old one: copy it from $SRC/env into .env."
fi
"${DC[@]}" stop mymail mail-bridge stalwart
"${DC[@]}" --profile tools run --rm --no-deps tools restore "/$SRC/mymail.db" /data/mymail.db
"${DC[@]}" --profile tools run --rm --no-deps --user root -v mymail_stalwart-data:/stalwart --entrypoint sh tools -c "find /stalwart -mindepth 1 -delete && tar xzf /$SRC/stalwart-data.tar.gz -C /stalwart"
"${DC[@]}" up -d
rm -rf backups/restore
echo "Restored from $ARCHIVE"
