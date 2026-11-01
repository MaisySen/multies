-- R112 (Nov 2): Anonymous reporting channel and data requests (REPORTING_R112). Additive only.
-- An anonymous report keeps no IP address, user agent or cookie: only what the reporter types, the times the deadlines need,
-- and a slow hash of the passphrase. Data request log rows hold who, when, what kinds and counts, never the data itself.
CREATE TABLE IF NOT EXISTS `report_channels` (
	`org_id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`requests_enabled` integer DEFAULT 0 NOT NULL,
	`intro` text DEFAULT '' NOT NULL,
	`default_handler_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `report_channels_public_uq` ON `report_channels` (`public_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`case_no` text NOT NULL,
	`pass_hash` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`handler_id` text,
	`summary` text DEFAULT '' NOT NULL,
	`outcome` text DEFAULT '' NOT NULL,
	`ack_due_at` integer NOT NULL,
	`outcome_due_at` integer NOT NULL,
	`acknowledged_at` integer,
	`closed_at` integer,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`reader_hash` text,
	`reader_expires_at` integer,
	`last_reporter_at` integer,
	`last_handler_at` integer,
	`handler_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `report_cases_no_uq` ON `report_cases` (`case_no`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_cases_org_status_idx` ON `report_cases` (`org_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_cases_org_handler_idx` ON `report_cases` (`org_id`,`handler_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`org_id` text NOT NULL,
	`author` text NOT NULL,
	`user_id` text,
	`internal` integer DEFAULT 0 NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `report_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_messages_case_idx` ON `report_messages` (`case_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_files` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`org_id` text NOT NULL,
	`blob_key` text NOT NULL,
	`parts` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `report_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `report_files_case_idx` ON `report_files` (`case_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `report_day` (
	`org_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `data_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`source` text NOT NULL,
	`created_by` text,
	`verify_hash` text,
	`verify_expires_at` integer,
	`verified_at` integer,
	`due_at` integer NOT NULL,
	`download_hash` text,
	`download_expires_at` integer,
	`done_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_requests_org_idx` ON `data_requests` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `data_requests_verify_uq` ON `data_requests` (`verify_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `data_requests_download_uq` ON `data_requests` (`download_hash`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `data_request_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`request_id` text,
	`actor_user_id` text,
	`actor_label` text NOT NULL,
	`action` text NOT NULL,
	`kinds` text DEFAULT '[]' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_request_log_org_idx` ON `data_request_log` (`org_id`,`created_at`);
