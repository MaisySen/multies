-- R103 (Oct 31): Docs plus. Additive only: the team link library (web clips keep the doc they made), comments on docs
-- (team, guest and public link threads, with moderation), and a per share link comments switch (off by default).
CREATE TABLE IF NOT EXISTS `link_library` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`url_key` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`site` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`doc_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `link_library_org_idx` ON `link_library` (`org_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `link_library_key_uq` ON `link_library` (`org_id`,`url_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `doc_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`thread` text DEFAULT 'team' NOT NULL,
	`share_link_id` text,
	`author_type` text DEFAULT 'member' NOT NULL,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`author_email` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'visible' NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`moderated_by` text,
	`moderated_at` integer,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_comments_doc_idx` ON `doc_comments` (`org_id`,`doc_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_comments_status_idx` ON `doc_comments` (`org_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `share_links` ADD `comments` text DEFAULT 'off' NOT NULL;
