-- R123 (Nov 1): Sites. One site per workspace with pages built from typed blocks (draft, scheduled and published
-- snapshots), page versions, moderated comments and page view counts (counts only: no address, no visitor id, no cookie).
-- Additive only.
CREATE TABLE IF NOT EXISTS `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`comments_on` integer DEFAULT 1 NOT NULL,
	`editors` text DEFAULT '[]' NOT NULL,
	`home_page_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sites_slug_uq` ON `sites` (`slug`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `sites_org_uq` ON `sites` (`org_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`draft_blocks` text DEFAULT '[]' NOT NULL,
	`seo_title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`image` text DEFAULT '' NOT NULL,
	`live` text,
	`next` text,
	`publish_at` integer,
	`published_at` integer,
	`members_can_view` integer DEFAULT 0 NOT NULL,
	`comments_on` integer DEFAULT 1 NOT NULL,
	`has_unpublished` integer DEFAULT 1 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_pages_slug_uq` ON `site_pages` (`site_id`,`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_pages_org_idx` ON `site_pages` (`org_id`,`position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_page_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`page_id` text NOT NULL REFERENCES `site_pages`(`id`) ON DELETE cascade,
	`kind` text DEFAULT 'saved' NOT NULL,
	`snapshot` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_page_versions_page_idx` ON `site_page_versions` (`page_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`page_id` text NOT NULL REFERENCES `site_pages`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sender_key` text NOT NULL,
	`moderated_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_comments_page_idx` ON `site_comments` (`page_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_comments_org_idx` ON `site_comments` (`org_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_comments_sender_idx` ON `site_comments` (`sender_key`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `site_page_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`page_id` text NOT NULL REFERENCES `site_pages`(`id`) ON DELETE cascade,
	`day` text NOT NULL,
	`source` text NOT NULL,
	`device` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_page_stats_org_idx` ON `site_page_stats` (`org_id`,`day`);
