-- R118: Social P2b. The inbox (comments, messages and mentions pulled from each account), internal notes and sent
-- replies, saved replies, results per post and account, per account state (last pull, health, bell told) and the
-- staging only test network. Additive only.
CREATE TABLE `social_inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`app` text NOT NULL,
	`kind` text NOT NULL,
	`remote_id` text NOT NULL,
	`target` text,
	`author_id` text,
	`author_name` text,
	`author_handle` text,
	`text` text NOT NULL,
	`post_url` text,
	`post_text` text,
	`received_at` integer NOT NULL,
	`last_inbound_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_id` text,
	`contact_id` text,
	`task_id` text,
	`replied_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_inbox_remote_uq` ON `social_inbox_items` (`org_id`,`account_id`,`remote_id`);--> statement-breakpoint
CREATE INDEX `social_inbox_list_idx` ON `social_inbox_items` (`org_id`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `social_inbox_assignee_idx` ON `social_inbox_items` (`org_id`,`assignee_id`,`status`);--> statement-breakpoint
CREATE TABLE `social_inbox_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`author_id` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `social_inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_inbox_notes_item_idx` ON `social_inbox_notes` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `social_saved_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_saved_replies_org_idx` ON `social_saved_replies` (`org_id`,`title`);--> statement-breakpoint
CREATE TABLE `social_post_stats` (
	`post_id` text NOT NULL,
	`account_id` text NOT NULL,
	`org_id` text NOT NULL,
	`app` text NOT NULL,
	`reach` integer,
	`engagement` integer,
	`clicks` integer,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `account_id`),
	FOREIGN KEY (`post_id`) REFERENCES `social_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_post_stats_org_idx` ON `social_post_stats` (`org_id`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `social_account_state` (
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`app` text NOT NULL,
	`inbox_synced_at` integer,
	`inbox_error` text,
	`stats_synced_at` integer,
	`health_code` text,
	`health_told_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `account_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_account_state_inbox_idx` ON `social_account_state` (`inbox_synced_at`);--> statement-breakpoint
CREATE TABLE `social_test_accounts` (
	`org_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`broken` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
