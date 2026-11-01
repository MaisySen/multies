-- R93: Forms plus. Chat style forms with hidden fields and a signed webhook, feedback boards with votes, and calls
-- for submissions with reviewers, a rubric and a shortlist. Additive only.
ALTER TABLE `forms` ADD `mode` text DEFAULT 'classic' NOT NULL;
--> statement-breakpoint
ALTER TABLE `forms` ADD `plus` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `forms` ADD `webhook_url` text;
--> statement-breakpoint
ALTER TABLE `forms` ADD `webhook_secret` text;
--> statement-breakpoint
ALTER TABLE `forms` ADD `webhook_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `form_submissions` ADD `meta` text;
--> statement-breakpoint
ALTER TABLE `form_submissions` ADD `score` real;
--> statement-breakpoint
ALTER TABLE `form_submissions` ADD `review_state` text DEFAULT 'new' NOT NULL;
--> statement-breakpoint
CREATE TABLE `form_webhook_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`form_id` text NOT NULL,
	`submission_id` text,
	`ok` integer DEFAULT false NOT NULL,
	`http_status` integer,
	`error` text,
	`ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `form_webhook_log_form_idx` ON `form_webhook_log` (`form_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `feedback_boards` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`slug` text NOT NULL,
	`is_public` integer DEFAULT true NOT NULL,
	`allow_ideas` integer DEFAULT true NOT NULL,
	`moderate` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_boards_org_idx` ON `feedback_boards` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_boards_slug_uq` ON `feedback_boards` (`slug`);
--> statement-breakpoint
CREATE TABLE `feedback_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`board_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`author_email` text,
	`author_user_id` text,
	`vote_count` integer DEFAULT 0 NOT NULL,
	`merged_into_id` text,
	`ip_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `feedback_boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feedback_posts_board_idx` ON `feedback_posts` (`board_id`,`status`,`vote_count`);
--> statement-breakpoint
CREATE INDEX `feedback_posts_board_new_idx` ON `feedback_posts` (`board_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `feedback_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`board_id` text NOT NULL,
	`post_id` text NOT NULL,
	`voter_key` text NOT NULL,
	`voter_name` text DEFAULT '' NOT NULL,
	`voter_email` text,
	`token_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `feedback_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_votes_post_voter_uq` ON `feedback_votes` (`post_id`,`voter_key`);
--> statement-breakpoint
CREATE INDEX `feedback_votes_board_voter_idx` ON `feedback_votes` (`board_id`,`voter_key`);
--> statement-breakpoint
CREATE TABLE `review_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`form_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`scores` text DEFAULT '{}' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`total` real,
	`done_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `form_submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_entry_reviewer_uq` ON `review_assignments` (`submission_id`,`reviewer_id`);
--> statement-breakpoint
CREATE INDEX `review_assignments_reviewer_idx` ON `review_assignments` (`org_id`,`reviewer_id`,`status`);
--> statement-breakpoint
CREATE INDEX `review_assignments_form_idx` ON `review_assignments` (`form_id`);
