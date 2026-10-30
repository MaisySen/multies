ALTER TABLE `organizations` ADD `channels_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `channels_agent_autosend` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `msg_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`external_account_id` text,
	`name` text NOT NULL,
	`handle` text,
	`token_enc` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`connected_by` text,
	`connected_at` integer NOT NULL,
	`disconnected_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `msg_channels_org_idx` ON `msg_channels` (`org_id`);--> statement-breakpoint
CREATE INDEX `msg_channels_external_idx` ON `msg_channels` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `msg_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`contact_external_id` text NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`last_message_at` integer NOT NULL,
	`last_inbound_at` integer,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_user_id` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `msg_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `msg_conversations_contact_uq` ON `msg_conversations` (`channel_id`,`contact_external_id`);--> statement-breakpoint
CREATE INDEX `msg_conversations_org_last_idx` ON `msg_conversations` (`org_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `msg_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`direction` text NOT NULL,
	`external_id` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`delivery` text NOT NULL,
	`error` text,
	`media_name` text,
	`media_type` text,
	`media_size` integer,
	`media_b64` text,
	`media_key` text,
	`template_name` text,
	`draft_payload` text,
	`sent_by_user_id` text,
	`sent_by_agent_id` text,
	`date` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `msg_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `msg_messages_conv_idx` ON `msg_messages` (`conversation_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `msg_messages_external_uq` ON `msg_messages` (`channel_id`,`external_id`);
