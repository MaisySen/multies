-- SA1 (Nov 1): one row per social account the workspace connected: the account's own id on its network, the name and
-- picture people know it by, and when we last asked. Additive only. The unique index is the server side guard: a
-- workspace holds one connection per network account, so connecting the same account again refreshes it. The
-- connections themselves live on the integration platform, so there are no rows to merge here yet; existing
-- duplicates are merged by the app the first time each workspace's accounts are listed.
CREATE TABLE IF NOT EXISTS `social_account_profiles` (
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`app` text NOT NULL,
	`external_id` text,
	`name` text,
	`avatar_url` text,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `account_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `social_account_profiles_ext_uq` ON `social_account_profiles` (`org_id`,`app`,`external_id`);
