#!/bin/sh
# Direct IMAP to IMAP copy with imapsync, for when MyMail's mail server (Stalwart) is the store
# of record, for example on the Australian VPS in deploy/au. It copies into the mailbox's IMAP
# account; use the runner (runner.mjs) instead while mail is stored in the app's database.
#
#   ./imapsync.sh imap.gmail.com you@gmail.com 'gmail app password' mail.example.com.au you@example.com.au 'mailbox app password'
set -eu
[ $# -eq 6 ] || { echo "usage: $0 SRC_HOST SRC_USER SRC_PASS DST_HOST DST_USER DST_PASS"; exit 1; }
EXTRA=""
case "$1" in
  imap.gmail.com) EXTRA="--gmail1" ;;
  outlook.office365.com) EXTRA="--office1" ;;
esac
exec docker run --rm gilleslamiral/imapsync imapsync $EXTRA \
  --host1 "$1" --user1 "$2" --password1 "$3" --ssl1 \
  --host2 "$4" --user2 "$5" --password2 "$6" --ssl2 \
  --exclude '^(\[Gmail\]/Spam|\[Gmail\]/Trash|Junk|Junk Email|Deleted Items)$' \
  --nofoldersizes --useuid
