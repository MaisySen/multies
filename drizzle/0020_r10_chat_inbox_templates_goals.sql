CREATE TABLE `chat_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text DEFAULT 'channel' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`project_id` text,
	`guest_access` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`dm_key` text,
	`last_message_at` integer,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_channels_org_idx` ON `chat_channels` (`org_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_channels_dm_uq` ON `chat_channels` (`org_id`,`dm_key`);--> statement-breakpoint
CREATE TABLE `chat_files` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_b64` text,
	`storage_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_files_message_idx` ON `chat_files` (`message_id`);--> statement-breakpoint
CREATE TABLE `chat_members` (
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`last_read_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_members_user_idx` ON `chat_members` (`user_id`,`org_id`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`parent_id` text,
	`author_type` text NOT NULL,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`mention_keys` text DEFAULT '' NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`last_reply_at` integer,
	`edited_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_channel_idx` ON `chat_messages` (`channel_id`,`parent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_updated_idx` ON `chat_messages` (`channel_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `chat_messages_parent_idx` ON `chat_messages` (`parent_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`owner_id` text,
	`parent_id` text,
	`start_at` integer,
	`due_at` integer,
	`health` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `goals_org_idx` ON `goals` (`org_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `key_results` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'number' NOT NULL,
	`start_value` real DEFAULT 0 NOT NULL,
	`target_value` real DEFAULT 100 NOT NULL,
	`current_value` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`project_id` text,
	`position` real DEFAULT 0 NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `key_results_goal_idx` ON `key_results` (`goal_id`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'Custom' NOT NULL,
	`data` text NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `templates_org_idx` ON `templates` (`org_id`,`kind`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `actor_name` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `repeat_rule` text;