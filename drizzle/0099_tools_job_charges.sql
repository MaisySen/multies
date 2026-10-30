-- R66 (MB-256): a Tools run is counted only when its job finishes with a result. One row per engine job that
-- was counted, so a status read that sees "done" again (a second tab, a page that resumed after a refresh) never
-- counts it twice. Rows carry no file names; the cron prunes them after 2 days with the day rows of tool_usage.
CREATE TABLE `tool_job_charges` (
	`job_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `tool_job_charges_created_idx` ON `tool_job_charges` (`created_at`);
