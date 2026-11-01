-- R96: chat plus. Topics inside channels, announcements with seen by, decision votes, polls, live Q&A and word clouds. Additive only.
ALTER TABLE `chat_messages` ADD `topic_id` text;
--> statement-breakpoint
CREATE INDEX `chat_messages_topic_idx` ON `chat_messages` (`topic_id`,`created_at`) WHERE `topic_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `chat_topics` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`last_message_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `chat_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_topics_name_uq` ON `chat_topics` (`channel_id`,`name_key`);
--> statement-breakpoint
CREATE TABLE `chat_topic_reads` (
	`topic_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`last_read_at` integer NOT NULL,
	PRIMARY KEY(`topic_id`, `user_id`),
	FOREIGN KEY (`topic_id`) REFERENCES `chat_topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_announcements` (
	`message_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`posted_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_announcements_org_idx` ON `chat_announcements` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `chat_announcement_reads` (
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `user_id`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_announcements`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text,
	`message_id` text,
	`meeting_id` text,
	`kind` text NOT NULL,
	`question` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`multi` integer DEFAULT false NOT NULL,
	`anonymous` integer DEFAULT false NOT NULL,
	`closes_at` integer,
	`closed_at` integer,
	`outcome` text,
	`created_by` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_polls_message_uq` ON `chat_polls` (`message_id`);
--> statement-breakpoint
CREATE INDEX `chat_polls_meeting_idx` ON `chat_polls` (`meeting_id`) WHERE `meeting_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `chat_polls_due_idx` ON `chat_polls` (`closed_at`,`closes_at`);
--> statement-breakpoint
CREATE TABLE `chat_poll_items` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`org_id` text NOT NULL,
	`body` text NOT NULL,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`answered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `chat_polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_poll_items_poll_idx` ON `chat_poll_items` (`poll_id`);
--> statement-breakpoint
CREATE TABLE `chat_poll_votes` (
	`poll_id` text NOT NULL,
	`voter` text NOT NULL,
	`choice` text NOT NULL,
	`org_id` text NOT NULL,
	`voter_name` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`poll_id`, `voter`, `choice`),
	FOREIGN KEY (`poll_id`) REFERENCES `chat_polls`(`id`) ON UPDATE no action ON DELETE cascade
);
