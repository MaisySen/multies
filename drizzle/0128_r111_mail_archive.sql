-- R111 (Nov 1): mail archive and retention. Additive only. No row here means keep mail forever: nothing is deleted
-- for a workspace until one of its owners or admins turns a policy on (and a 7 day grace has passed).
CREATE TABLE IF NOT EXISTS `mail_retention_policies` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`keep_years` integer,
	`starts_at` integer,
	`enabled_at` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	`last_run_at` integer,
	`last_run_deleted` integer DEFAULT 0 NOT NULL,
	`total_deleted` integer DEFAULT 0 NOT NULL,
	`backlog` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mail_retention_due_idx` ON `mail_retention_policies` (`enabled`,`last_run_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mail_legal_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`released_at` integer,
	`released_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mail_legal_holds_org_idx` ON `mail_legal_holds` (`org_id`,`released_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mail_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_exported_at` integer,
	`export_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mail_cases_org_idx` ON `mail_cases` (`org_id`,`created_at`);
