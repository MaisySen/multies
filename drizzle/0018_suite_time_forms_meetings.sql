CREATE TABLE `form_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`form_id` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `form_submissions_form_idx` ON `form_submissions` (`form_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`slug` text NOT NULL,
	`target` text DEFAULT 'task' NOT NULL,
	`project_id` text,
	`assignee_type` text,
	`assignee_id` text,
	`fields` text DEFAULT '[]' NOT NULL,
	`success_message` text DEFAULT 'Thanks, we got it.' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`submit_count` integer DEFAULT 0 NOT NULL,
	`last_submit_at` integer,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `forms_org_idx` ON `forms` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `forms_slug_uq` ON `forms` (`slug`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`room` text NOT NULL,
	`guest_token` text NOT NULL,
	`starts_at` integer NOT NULL,
	`duration_min` integer DEFAULT 30 NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`source_type` text,
	`source_id` text,
	`invitees` text DEFAULT '[]' NOT NULL,
	`mailbox_id` text,
	`invites_sent_at` integer,
	`ended_at` integer,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meetings_org_idx` ON `meetings` (`org_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `meetings_guest_token_uq` ON `meetings` (`guest_token`);--> statement-breakpoint
CREATE INDEX `meetings_source_idx` ON `meetings` (`org_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`task_id` text,
	`project_id` text,
	`person_type` text DEFAULT 'member' NOT NULL,
	`person_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`seconds` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`billable` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'timer' NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `time_entries_org_person_idx` ON `time_entries` (`org_id`,`person_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `time_entries_org_project_idx` ON `time_entries` (`org_id`,`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `time_entries_task_idx` ON `time_entries` (`task_id`);