-- R94: CRM timeline. Logged notes, calls and meeting summaries per contact, company or deal; saved segments of
-- contacts; deal probability, won and lost reasons and close date; indexes so a timeline with thousands of events
-- pages fast. Additive only.
CREATE TABLE `crm_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text DEFAULT 'note' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`outcome` text,
	`duration_min` integer,
	`occurred_at` integer NOT NULL,
	`private` integer DEFAULT false NOT NULL,
	`author_name` text,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `crm_entries_entity_idx` ON `crm_entries` (`org_id`,`entity_type`,`entity_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `crm_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `crm_segments_org_idx` ON `crm_segments` (`org_id`);
--> statement-breakpoint
ALTER TABLE `deals` ADD `probability` integer;
--> statement-breakpoint
ALTER TABLE `deals` ADD `close_reason` text;
--> statement-breakpoint
ALTER TABLE `deals` ADD `closed_at` integer;
--> statement-breakpoint
CREATE INDEX `deals_contact_idx` ON `deals` (`contact_id`) WHERE `contact_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `deals_company_idx` ON `deals` (`company_id`) WHERE `company_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `bookings_org_email_idx` ON `bookings` (`org_id`,`email`);
--> statement-breakpoint
CREATE INDEX `form_submissions_entity_idx` ON `form_submissions` (`entity_type`,`entity_id`,`created_at`) WHERE `entity_id` IS NOT NULL;
