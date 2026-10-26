-- R33: "select all" in mail runs as one server job (services/mail/bulk-job-r33.ts). The client names the job
-- (client id, so a repeated request continues it instead of starting a second one), the server freezes the set at
-- max_received_at (mail that arrives mid job is left alone) and keeps the undo plan (only what it changed).
CREATE TABLE `mail_bulk_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`client_job_id` text NOT NULL,
	`action` text NOT NULL,
	`params` text NOT NULL,
	`max_received_at` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`undo_plan` text DEFAULT '[]' NOT NULL,
	`undo_done` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_bulk_jobs_client_idx` ON `mail_bulk_jobs` (`org_id`,`client_job_id`);
