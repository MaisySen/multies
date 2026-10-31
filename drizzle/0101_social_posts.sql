-- R80C: Social posts from Connections. A post is written once, then each connected account it goes to gets a target
-- row with its own result. The cron pass takes due posts by (status, run_at). Images wait in social_media (base64,
-- 1 MB at most, the way logos are kept) behind an unguessable token, so the networks can fetch them; the cron pass
-- drops them 7 days after the post is done. Plain tables only; the sign in tokens for the accounts are not here.
CREATE TABLE `social_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text,
	`text` text NOT NULL,
	`media_id` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_posts_due_idx` ON `social_posts` (`status`,`run_at`);
--> statement-breakpoint
CREATE INDEX `social_posts_org_idx` ON `social_posts` (`org_id`,`run_at`);
--> statement-breakpoint
CREATE TABLE `social_post_targets` (
	`post_id` text NOT NULL,
	`account_id` text NOT NULL,
	`app` text NOT NULL,
	`label` text,
	`target` text,
	`target_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`url` text,
	`error` text,
	`sent_at` integer,
	PRIMARY KEY(`post_id`, `account_id`),
	FOREIGN KEY (`post_id`) REFERENCES `social_posts`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `social_media` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`token` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_b64` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
