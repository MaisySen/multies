-- R130 (Nov 2): guided onboarding. Workspace tours an admin builds, and each person's progress (checklist, built in and workspace tours). Additive only.
CREATE TABLE IF NOT EXISTS `tours` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`page` text NOT NULL,
	`audience` text DEFAULT 'all' NOT NULL,
	`new_days` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tours_org_idx` ON `tours` (`org_id`,`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tour_progress` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`state` text NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`data` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`, `key`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
