-- OPS1: operators' private notes on a workspace or a person.
CREATE TABLE `operator_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`body` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`author_user_id` text,
	`author_email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `operator_notes_target_idx` ON `operator_notes` (`target_type`,`target_id`,`created_at`);
