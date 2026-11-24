-- PRIV1b P60 (round 2, owner decision): a mailbox connected through an unrecognised server ("Other server", or a known
-- provider with its servers changed) waits, with status 'verifying', until the person enters a code emailed to the
-- address. These columns hold the code's HMAC, when it ends, wrong tries and when it was sent. All null or 0 on
-- existing rows, which stay as they are; old code never reads them (and never sees the new status, set only by new code).
ALTER TABLE `mail_connections` ADD `verify_code_hash` text;--> statement-breakpoint
ALTER TABLE `mail_connections` ADD `verify_expires_at` integer;--> statement-breakpoint
ALTER TABLE `mail_connections` ADD `verify_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `mail_connections` ADD `verify_sent_at` integer;
