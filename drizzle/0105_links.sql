-- R87: Links in Tools. Short links (/l/<code>), their clicks (no address stored: a visitor hash with a daily salt), one
-- bio page per workspace and per person (/bio/<slug>), team go links (go/<name>) and a workspace's own link domain.
-- Additive only. The public pages read one row by its unique key (code, slug or host).
CREATE TABLE `short_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`code` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`max_clicks` integer,
	`password_hash` text,
	`clicks` integer DEFAULT 0 NOT NULL,
	`bot_clicks` integer DEFAULT 0 NOT NULL,
	`last_click_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `short_links_code_uq` ON `short_links` (`code`);
--> statement-breakpoint
CREATE INDEX `short_links_org_idx` ON `short_links` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `link_clicks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`link_id` text NOT NULL,
	`day` text NOT NULL,
	`at` integer NOT NULL,
	`country` text,
	`referrer` text,
	`device` text,
	`browser` text,
	`os` text,
	`visitor` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `link_clicks_link_day_idx` ON `link_clicks` (`link_id`,`day`);
--> statement-breakpoint
CREATE TABLE `link_bio_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`bio` text,
	`avatar` text DEFAULT 'logo' NOT NULL,
	`avatar_url` text,
	`theme` text DEFAULT 'brand' NOT NULL,
	`brand_color` text,
	`items` text DEFAULT '[]' NOT NULL,
	`socials` text DEFAULT '[]' NOT NULL,
	`published` integer DEFAULT 0 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_bio_pages_slug_uq` ON `link_bio_pages` (`slug`);
--> statement-breakpoint
CREATE INDEX `link_bio_pages_org_idx` ON `link_bio_pages` (`org_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `go_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text,
	`url` text,
	`label` text,
	`description` text,
	`clicks` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `go_links_org_name_uq` ON `go_links` (`org_id`,`name`);
--> statement-breakpoint
CREATE TABLE `link_hosts` (
	`org_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`domain_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `link_hosts_host_uq` ON `link_hosts` (`host`);
