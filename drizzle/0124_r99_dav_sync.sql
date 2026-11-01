-- R99 (Nov 1): calendar and contacts sync (CalDAV and CardDAV). Additive only.
-- App passwords: one person in one workspace, only a SHA-256 hash kept, named, revocable (the row is deleted).
CREATE TABLE IF NOT EXISTS `dav_app_passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `dav_app_passwords_hash_uq` ON `dav_app_passwords` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dav_app_passwords_user_idx` ON `dav_app_passwords` (`org_id`,`user_id`);--> statement-breakpoint
-- Sync tokens (RFC 6578): a snapshot of (name, etag) per collection per app password; a few kept, older ones pruned.
CREATE TABLE IF NOT EXISTS `dav_sync_states` (
	`id` text PRIMARY KEY NOT NULL,
	`password_id` text NOT NULL REFERENCES `dav_app_passwords`(`id`) ON DELETE cascade,
	`collection` text NOT NULL,
	`members` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dav_sync_states_pw_idx` ON `dav_sync_states` (`password_id`,`collection`,`created_at`);--> statement-breakpoint
-- The resource name a phone chose for an item it created (so it finds the item under the same name), and its UID.
CREATE TABLE IF NOT EXISTS `dav_names` (
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`collection` text NOT NULL,
	`name` text NOT NULL,
	`entity_id` text NOT NULL,
	`uid` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `collection`, `name`)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dav_names_entity_idx` ON `dav_names` (`org_id`,`collection`,`entity_id`);
