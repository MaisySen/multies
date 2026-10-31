-- R117: Social P2a. Formats, per network text, extras, carousels, campaigns, evergreen, drafts and approvals on posts;
-- a note per account (first comment result); images kept for the library and evergreen posts; weekly time slots;
-- the library (images, saved captions, hashtag sets). Additive only.
ALTER TABLE `social_posts` ADD `format` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `texts` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `extras` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `media_ids` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `campaign` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `evergreen` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `evergreen_of` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `submitted_by` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD `note` text;--> statement-breakpoint
ALTER TABLE `social_media` ADD `kept` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `social_posts_org_status_idx` ON `social_posts` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `social_posts_evergreen_idx` ON `social_posts` (`evergreen`,`org_id`);--> statement-breakpoint
CREATE TABLE `social_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text,
	`weekday` integer NOT NULL,
	`minute` integer NOT NULL,
	`tz` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_slots_org_idx` ON `social_slots` (`org_id`);--> statement-breakpoint
CREATE TABLE `social_library` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`body` text,
	`media_id` text,
	`campaign` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `social_library_org_idx` ON `social_library` (`org_id`,`created_at`);
