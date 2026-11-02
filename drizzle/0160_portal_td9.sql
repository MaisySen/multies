CREATE TABLE `client_portal_access` (
	`person_id` text NOT NULL,
	`area` text NOT NULL,
	`portal_id` text NOT NULL,
	`org_id` text NOT NULL,
	`level` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`person_id`, `area`)
);
--> statement-breakpoint
CREATE INDEX `client_portal_access_portal_idx` ON `client_portal_access` (`portal_id`);
--> statement-breakpoint
ALTER TABLE `client_portal_items` ADD `project_id` text;
--> statement-breakpoint
CREATE TABLE `portal_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`due_date` text,
	`done_at` integer,
	`position` integer NOT NULL DEFAULT 0,
	`created_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `portal_milestones_project_idx` ON `portal_milestones` (`org_id`, `project_id`);
--> statement-breakpoint
CREATE TABLE `item_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`portal_id` text,
	`author_user_id` text,
	`author_person_id` text,
	`author_name` text NOT NULL,
	`to_user_id` text,
	`to_person_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `item_comments_target_idx` ON `item_comments` (`org_id`, `target_kind`, `target_id`, `created_at`);
