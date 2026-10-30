CREATE TABLE `custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `custom_fields_project_idx` ON `custom_fields` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_guests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invite_hash` text,
	`invite_expires_at` integer,
	`session_hash` text,
	`last_seen_at` integer,
	`invited_by_type` text DEFAULT 'member' NOT NULL,
	`invited_by_id` text,
	`approval_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_guests_project_email_uq` ON `project_guests` (`project_id`,`email`);--> statement-breakpoint
CREATE INDEX `project_guests_org_idx` ON `project_guests` (`org_id`);--> statement-breakpoint
CREATE INDEX `project_guests_invite_idx` ON `project_guests` (`invite_hash`);--> statement-breakpoint
CREATE INDEX `project_guests_session_idx` ON `project_guests` (`session_hash`);--> statement-breakpoint
CREATE TABLE `task_field_values` (
	`task_id` text NOT NULL,
	`field_id` text NOT NULL,
	`org_id` text NOT NULL,
	`value_text` text,
	`value_num` real,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `field_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `custom_fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_field_values_field_text_idx` ON `task_field_values` (`field_id`,`value_text`);--> statement-breakpoint
CREATE INDEX `task_field_values_field_num_idx` ON `task_field_values` (`field_id`,`value_num`);--> statement-breakpoint
CREATE TABLE `task_files` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`task_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_b64` text,
	`storage_key` text,
	`uploaded_by_type` text NOT NULL,
	`uploaded_by_id` text,
	`uploaded_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_files_task_idx` ON `task_files` (`task_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `health` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `health_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_user_id` text;