-- R124 (Nov 1): Blog with newsletter, inside Sites. One blog per site; posts keep their body in a doc and publish an
-- escaped HTML snapshot; authors with public profiles; images of live posts that the public image route may serve.
-- Subscribers live in an R109 audience list (no new subscriber table). Additive only.
CREATE TABLE IF NOT EXISTS `site_blogs` (
	`site_id` text PRIMARY KEY NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`title` text DEFAULT 'Blog' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`list_id` text,
	`root_doc_id` text,
	`subscribe_on` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_blogs_org_uq` ON `site_blogs` (`org_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `blog_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`doc_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`cover` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`author_id` text,
	`live` text,
	`live_html` text,
	`live_version` integer,
	`publish_at` integer,
	`published_at` integer,
	`email_on_publish` integer DEFAULT 0 NOT NULL,
	`campaign_id` text,
	`emailed_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `blog_posts_slug_uq` ON `blog_posts` (`site_id`,`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blog_posts_org_idx` ON `blog_posts` (`org_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blog_posts_live_idx` ON `blog_posts` (`site_id`,`publish_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blog_posts_doc_idx` ON `blog_posts` (`doc_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `blog_authors` (
	`site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`photo` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `user_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `blog_authors_slug_uq` ON `blog_authors` (`site_id`,`slug`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `blog_images` (
	`site_id` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`owner` text NOT NULL,
	`image_id` text NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	PRIMARY KEY(`site_id`, `owner`, `image_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `blog_images_image_idx` ON `blog_images` (`site_id`,`image_id`);
