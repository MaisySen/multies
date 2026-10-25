CREATE TABLE `calendar_feeds` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`include_tasks` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`reset_at` integer,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feeds_token_uq` ON `calendar_feeds` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `calendar_sources` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`connection_id` text,
	`url_enc` text,
	`calendars` text DEFAULT '[]' NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#8E8E93' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`, `id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `mail_connections`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
