-- R115: maps. One saved address per contact, company or booking page (with its map point when found), a shared cache
-- of address lookups keyed by a hash of the query (the query text is not stored), a daily lookup count per workspace,
-- and one row per lookup service so the whole app calls each at most once a second. Additive only.
CREATE TABLE `places` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`address` text NOT NULL,
	`lat` real,
	`lon` real,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `places_entity_uq` ON `places` (`org_id`,`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE TABLE `geo_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`results` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `geo_usage` (
	`org_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `geo_throttle` (
	`service` text PRIMARY KEY NOT NULL,
	`next_at` integer DEFAULT 0 NOT NULL
);
