-- Tools P2: the AI meter. One row per UTC day per workspace (org_id) plus one row per day with org_id '*'
-- holding the whole account's count. Units are the AI service's own daily units, estimated before each call
-- and reserved here first (one upsert guarded by the cap), then settled to the real figure after the call.
-- The global row never passes 9,000 so the account stays inside its free daily allocation. The cron prunes
-- rows older than 2 days. WITHOUT ROWID so a reservation writes only the primary key b-tree row.
CREATE TABLE `ai_usage_daily` (
	`day` text NOT NULL,
	`org_id` text NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `org_id`)
) WITHOUT ROWID;
