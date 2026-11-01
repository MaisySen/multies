-- R101 (Nov 1): Files plus. Additive only: the workspace drive (items, versions, stars, shares). File bytes are not
-- stored here (S3 body store or the separate FILES_DB database).
CREATE TABLE IF NOT EXISTS `drive_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`space` text NOT NULL,
	`owner_id` text,
	`parent_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`version_id` text,
	`versions` integer DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`updated_by` text,
	`trashed_at` integer,
	`trashed_by` text,
	`trash_root_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_items_parent_idx` ON `drive_items` (`org_id`,`space`,`parent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_items_owner_idx` ON `drive_items` (`org_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_items_trash_idx` ON `drive_items` (`org_id`,`trash_root_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_items_updated_idx` ON `drive_items` (`org_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drive_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`item_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`blob_key` text NOT NULL,
	`parts` integer NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_versions_item_idx` ON `drive_versions` (`item_id`,`number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_versions_org_idx` ON `drive_versions` (`org_id`,`blob_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drive_stars` (
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `item_id`)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_stars_org_idx` ON `drive_stars` (`org_id`,`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `drive_shares` (
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`item_id`, `user_id`)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `drive_shares_user_idx` ON `drive_shares` (`org_id`,`user_id`);
