-- R126 People: staff profiles (no salary or ID numbers), away date ranges, onboarding and offboarding templates, runs that
-- link each checklist item to exactly one task (idempotent reassign), and the assets register with its event history. Additive only.
CREATE TABLE `staff_profiles` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`team` text DEFAULT '' NOT NULL,
	`manager_user_id` text,
	`skills` text DEFAULT '[]' NOT NULL,
	`start_date` text,
	`location` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`days_off` text DEFAULT '[0,6]' NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `staff_away` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `staff_away_org_end_idx` ON `staff_away` (`org_id`, `end_date`);
--> statement-breakpoint
CREATE TABLE `onboarding_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text DEFAULT 'onboarding' NOT NULL,
	`name` text NOT NULL,
	`items` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `onboarding_templates_org_idx` ON `onboarding_templates` (`org_id`);
--> statement-breakpoint
CREATE TABLE `onboarding_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`template_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_runs_person_tpl_uq` ON `onboarding_runs` (`org_id`, `user_id`, `template_id`);
--> statement-breakpoint
CREATE TABLE `onboarding_run_tasks` (
	`run_id` text NOT NULL,
	`item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`task_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`tag` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`serial` text DEFAULT '' NOT NULL,
	`purchase_date` text,
	`warranty_end` text,
	`value_cents` integer,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`assigned_user_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_org_tag_uq` ON `assets` (`org_id`, `tag`);
--> statement-breakpoint
CREATE INDEX `assets_org_user_idx` ON `assets` (`org_id`, `assigned_user_id`);
--> statement-breakpoint
CREATE TABLE `asset_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`action` text NOT NULL,
	`user_id` text,
	`by_user_id` text,
	`by_name` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `asset_events_asset_idx` ON `asset_events` (`asset_id`, `at`);
