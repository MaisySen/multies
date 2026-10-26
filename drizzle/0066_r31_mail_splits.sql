-- R31: split inbox and read status on sent mail.
-- messages.is_bulk: set on inbound ingest from List-Unsubscribe, List-Id, Precedence and Auto-Submitted headers
-- (null on older rows: the split reads the sender address instead, so no backfill write is needed).
ALTER TABLE `messages` ADD `is_bulk` integer;
--> statement-breakpoint
-- A person's own inbox splits (per user per workspace), in order. rules_json: [{ field, value }]; match: all | any.
CREATE TABLE `mail_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`rules_json` text DEFAULT '[]' NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`leaves_important` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_splits_user_idx` ON `mail_splits` (`org_id`,`user_id`,`position`);
--> statement-breakpoint
-- Read status: one row per sent message that carried the open image. The token in the image URL is random (no PII).
CREATE TABLE `mail_opens` (
	`token` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text,
	`opens` integer DEFAULT 0 NOT NULL,
	`first_open_at` integer,
	`last_open_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_opens_message_idx` ON `mail_opens` (`message_id`);
--> statement-breakpoint
-- Per person mail preferences. read_status: "Show when people open my mail" (off by default).
CREATE TABLE `mail_prefs` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`read_status` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
