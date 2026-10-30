CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`page_id` text NOT NULL,
	`meeting_id` text,
	`starts_at` integer NOT NULL,
	`duration_min` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`slot_key` integer,
	`cancel_token_hash` text NOT NULL,
	`cancelled_by` text,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`page_id`) REFERENCES `scheduling_pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bookings_page_idx` ON `bookings` (`page_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `bookings_org_idx` ON `bookings` (`org_id`,`starts_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_slot_uq` ON `bookings` (`page_id`,`slot_key`);--> statement-breakpoint
CREATE TABLE `incoming_hooks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`last_called_at` integer,
	`recent` text DEFAULT '[]' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `incoming_hooks_org_idx` ON `incoming_hooks` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `incoming_hooks_token_uq` ON `incoming_hooks` (`token_hash`);--> statement-breakpoint
CREATE TABLE `scheduling_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`timezone` text NOT NULL,
	`hours` text NOT NULL,
	`slot_min` integer DEFAULT 30 NOT NULL,
	`buffer_min` integer DEFAULT 0 NOT NULL,
	`max_days_ahead` integer DEFAULT 30 NOT NULL,
	`min_notice_min` integer DEFAULT 120 NOT NULL,
	`video` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_pages_slug_uq` ON `scheduling_pages` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_pages_user_uq` ON `scheduling_pages` (`org_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD `format` text DEFAULT 'json' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD `connector` text;