-- R95 (Nov 1): Tasks plus. Additive only: My Day time blocks per person and day, weekly timesheet submit and
-- approve, and tags on time entries.
CREATE TABLE IF NOT EXISTS `day_plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`task_id` text NOT NULL,
	`day` text NOT NULL,
	`start_min` integer,
	`minutes` integer DEFAULT 30 NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `day_plan_items_person_day_task` ON `day_plan_items` (`org_id`,`user_id`,`day`,`task_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `timesheets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`person_id` text NOT NULL,
	`week_start` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`submitted_at` integer,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `timesheets_person_week` ON `timesheets` (`org_id`,`person_id`,`week_start`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `timesheets_org_status_idx` ON `timesheets` (`org_id`,`status`,`week_start`);--> statement-breakpoint
ALTER TABLE `time_entries` ADD `tags` text DEFAULT '[]' NOT NULL;
