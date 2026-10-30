-- R61 D1 reads: the connected mailbox sync read the whole mailbox several times a pass. Measured on production
-- (hour 00 UTC, 30 Oct, one mailbox of about 10,500 rows mid backfill): 2.83M rows read for about 5,000 stored
-- messages, about 560 rows read per stored message. Three reads had no index to walk:
-- the flag window (mailbox, folder key, UID range) and the oldest stored UID of a folder (min over the same) read every
-- row of the mailbox through the mailbox prefix of another index, and the header repair sweep (mailbox, id order, rows
-- still missing a sender or a preview) did the same and sorted. Partial indexes: only synced copies (remote_box set)
-- and only rows still waiting for repair are indexed, so mail sent or received in Multies itself writes no extra row.
CREATE INDEX IF NOT EXISTS `messages_mailbox_remote_idx` ON `messages` (`mailbox_id`,`remote_box`,`remote_uid`) WHERE "messages"."remote_box" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `messages_mailbox_repair_idx` ON `messages` (`mailbox_id`,`id`) WHERE "messages"."remote_uid" IS NOT NULL AND ("messages"."from_address" = 'unknown@invalid' OR ("messages"."size_bytes" < 0 AND "messages"."snippet" = ''));
