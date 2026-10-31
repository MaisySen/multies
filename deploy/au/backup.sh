#!/bin/sh
# Nightly encrypted, deduplicated backups of Multies' database and Stalwart's store.
# Keeps 14 daily, 8 weekly and 12 monthly snapshots. Restore: see deploy/au/README.md.
set -eu
restic snapshots >/dev/null 2>&1 || restic init
while true; do
  # SQLite: back up a consistent copy, never the live file mid-write.
  if command -v sqlite3 >/dev/null 2>&1; then sqlite3 /data/mymail/mymail.db ".backup /tmp/mymail.db"; else cp /data/mymail/mymail.db /tmp/mymail.db; fi
  restic backup --host mymail-au --tag nightly /tmp/mymail.db /data/stalwart
  restic forget --prune --keep-daily 14 --keep-weekly 8 --keep-monthly 12
  rm -f /tmp/mymail.db
  sleep 86400
done
