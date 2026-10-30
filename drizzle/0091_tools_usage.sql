-- Tools P1: document tools usage per workspace. One row per month (period "2026-10") and one per day
-- (period "2026-10-30"); a run adds one to both in a single upsert. The cron prunes day rows after 2 days
-- and month rows after 13 months. WITHOUT ROWID so a run writes only the primary key b-tree row.
CREATE TABLE `tool_usage` (
	`org_id` text NOT NULL,
	`period` text NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`bytes_in` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `period`)
) WITHOUT ROWID;
