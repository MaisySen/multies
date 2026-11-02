CREATE TABLE `ai_trust` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ask_messages` ADD `meta` text;
