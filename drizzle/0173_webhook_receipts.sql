-- Round 2: signed webhooks (the Supabase auth hook, Resend events, the Cloudflare Email Worker, TikTok) note each
-- delivery id here before running it, so a captured request replayed inside the 5 minute signature window is answered
-- "already handled" and not run again. WITHOUT ROWID keeps a receipt at one row written (the primary key is the table).
-- The maintenance pass deletes receipts older than about 10 minutes, so the table stays small. Older code never reads it.
CREATE TABLE IF NOT EXISTS `webhook_receipts` (
	`source` text NOT NULL,
	`receipt_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`source`, `receipt_id`)
) WITHOUT ROWID;
