-- R35 (Apple 1.2, user generated content): reports of chat messages and people, and per person blocks.
-- content_reports: one row per report (essential write). The message text and author are copied at report time,
-- so an edit or delete afterwards does not change what the operator reviews.
CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`org_id` text,
	`target_type` text NOT NULL,
	`message_id` text,
	`target_user_id` text,
	`context` text,
	`reason` text NOT NULL,
	`note` text,
	`snapshot_text` text,
	`snapshot_author_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`action` text DEFAULT 'none' NOT NULL,
	`resolution_note` text,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `content_reports_status_idx` ON `content_reports` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `content_reports_reporter_idx` ON `content_reports` (`reporter_user_id`,`created_at`);
--> statement-breakpoint
-- user_blocks: A (blocker) blocked B (blocked), across every workspace they share.
CREATE TABLE `user_blocks` (
	`blocker_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`blocked_user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_user_id`, `blocked_user_id`)
);
--> statement-breakpoint
CREATE INDEX `user_blocks_blocked_idx` ON `user_blocks` (`blocked_user_id`);
