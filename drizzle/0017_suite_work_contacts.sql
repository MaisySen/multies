CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`verb` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_entity_idx` ON `activity` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_org_idx` ON `activity` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger` text NOT NULL,
	`conditions` text DEFAULT '{}' NOT NULL,
	`action` text NOT NULL,
	`action_config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automations_org_trigger_idx` ON `automations` (`org_id`,`trigger`);--> statement-breakpoint
CREATE TABLE `changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`op` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `changes_org_seq_idx` ON `changes` (`org_id`,`seq`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `companies_org_idx` ON `companies` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_org_domain_uq` ON `companies` (`org_id`,`domain`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`company_id` text,
	`name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`title` text,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'mail' NOT NULL,
	`owner_user_id` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`first_contact_at` integer,
	`last_contact_at` integer,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_org_email_uq` ON `contacts` (`org_id`,`email`);--> statement-breakpoint
CREATE INDEX `contacts_org_last_idx` ON `contacts` (`org_id`,`last_contact_at`);--> statement-breakpoint
CREATE INDEX `contacts_company_idx` ON `contacts` (`company_id`);--> statement-breakpoint
CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`stage` text DEFAULT 'lead' NOT NULL,
	`value_cents` integer DEFAULT 0 NOT NULL,
	`contact_id` text,
	`company_id` text,
	`owner_user_id` text,
	`expected_close_at` integer,
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
CREATE INDEX `deals_org_stage_idx` ON `deals` (`org_id`,`stage`,`position`);--> statement-breakpoint
CREATE TABLE `docs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '{"type":"doc","content":[]}' NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`project_id` text,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `docs_org_idx` ON `docs` (`org_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `entity_links` (
	`org_id` text NOT NULL,
	`from_type` text NOT NULL,
	`from_id` text NOT NULL,
	`to_type` text NOT NULL,
	`to_id` text NOT NULL,
	`relation` text DEFAULT 'related' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`from_type`, `from_id`, `to_type`, `to_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entity_links_to_idx` ON `entity_links` (`org_id`,`to_type`,`to_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`title` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`color` text DEFAULT '#8a8f98' NOT NULL,
	`position` integer NOT NULL,
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
CREATE INDEX `project_statuses_project_idx` ON `project_statuses` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`key` text NOT NULL,
	`color` text DEFAULT '#ff5a36' NOT NULL,
	`next_number` integer DEFAULT 1 NOT NULL,
	`archived_at` integer,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_org_idx` ON `projects` (`org_id`);--> statement-breakpoint
CREATE TABLE `push_devices` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`platform` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `push_devices_org_idx` ON `push_devices` (`org_id`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text,
	`user_id` text,
	`name` text NOT NULL,
	`view` text DEFAULT 'list' NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_views_org_idx` ON `saved_views` (`org_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`task_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_comments_task_idx` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`status_id` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`assignee_type` text,
	`assignee_id` text,
	`priority` text DEFAULT 'none' NOT NULL,
	`start_at` integer,
	`due_at` integer,
	`labels` text DEFAULT '[]' NOT NULL,
	`parent_id` text,
	`position` real DEFAULT 0 NOT NULL,
	`thread_id` text,
	`message_id` text,
	`source_from` text,
	`source_subject` text,
	`completed_at` integer,
	`reminder_sent_for` text,
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
CREATE INDEX `tasks_org_project_idx` ON `tasks` (`org_id`,`project_id`,`status_id`,`position`);--> statement-breakpoint
CREATE INDEX `tasks_org_thread_idx` ON `tasks` (`org_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `tasks_org_due_idx` ON `tasks` (`org_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_number_uq` ON `tasks` (`project_id`,`number`);