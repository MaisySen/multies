-- TD4 (Nov 2): time to invoice. Billed time entries point at the draft or issued invoice that carries them, so the same
-- time can not be billed twice; rates and the client per project; one row per billing run for the record and CSV.
-- Additive only.
ALTER TABLE `time_entries` ADD `billed_doc_id` text;
--> statement-breakpoint
ALTER TABLE `time_entries` ADD `billed_at` integer;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `time_entries_billed_idx` ON `time_entries` (`org_id`,`billed_doc_id`) WHERE `billed_doc_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bill_projects` (
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`project_id` text NOT NULL,
	`contact_id` text,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`rate_cents` integer,
	`rounding` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`org_id`, `project_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bill_rates` (
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`project_id` text NOT NULL,
	`person_id` text NOT NULL,
	`rate_cents` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`org_id`, `project_id`, `person_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bill_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`project_id` text NOT NULL,
	`contact_id` text,
	`doc_id` text NOT NULL,
	`date_from` text NOT NULL,
	`date_to` text NOT NULL,
	`rounding` integer DEFAULT 0 NOT NULL,
	`entry_count` integer DEFAULT 0 NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL,
	`amount_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`released_at` integer,
	`released_by` text,
	`release_reason` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bill_runs_org_idx` ON `bill_runs` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `bill_runs_doc_idx` ON `bill_runs` (`org_id`,`doc_id`);
