-- R119: helpdesk mode on the shared inbox (tickets, SLA clocks, macros, survey) and the website chat. Additive only.
CREATE TABLE `hd_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`widget_key` text NOT NULL,
	`ticket_seq` integer DEFAULT 1000 NOT NULL,
	`sync_cursor` integer DEFAULT 0 NOT NULL,
	`synced_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hd_settings_widget_key_uq` ON `hd_settings` (`widget_key`);--> statement-breakpoint
CREATE TABLE `hd_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`mailbox_id` text,
	`subject` text DEFAULT '' NOT NULL,
	`snippet` text DEFAULT '' NOT NULL,
	`requester_name` text DEFAULT '' NOT NULL,
	`requester_email` text,
	`contact_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_user_id` text,
	`created_at` integer NOT NULL,
	`last_message_at` integer NOT NULL,
	`first_reply_at` integer,
	`first_reply_due_at` integer,
	`resolve_due_at` integer,
	`resolve_used_min` integer DEFAULT 0 NOT NULL,
	`running_since` integer,
	`solved_at` integer,
	`unread` integer DEFAULT 0 NOT NULL,
	`csat_token_hash` text,
	`csat_rating` text,
	`csat_comment` text,
	`csat_at` integer,
	`visitor_token_hash` text,
	`visitor_typing_at` integer,
	`agent_typing_at` integer,
	`visitor_seen_at` integer,
	`offline` integer DEFAULT false NOT NULL,
	`page_url` text,
	`window_start` integer DEFAULT 0 NOT NULL,
	`window_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hd_tickets_ref_uq` ON `hd_tickets` (`org_id`,`kind`,`ref_id`);--> statement-breakpoint
CREATE INDEX `hd_tickets_org_status_idx` ON `hd_tickets` (`org_id`,`status`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `hd_tickets_org_assignee_idx` ON `hd_tickets` (`org_id`,`assignee_user_id`);--> statement-breakpoint
CREATE INDEX `hd_tickets_csat_idx` ON `hd_tickets` (`csat_token_hash`);--> statement-breakpoint
CREATE INDEX `hd_tickets_visitor_idx` ON `hd_tickets` (`visitor_token_hash`);--> statement-breakpoint
CREATE TABLE `hd_web_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`author` text NOT NULL,
	`author_user_id` text,
	`text` text NOT NULL,
	`via` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `hd_tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hd_web_messages_ticket_idx` ON `hd_web_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hd_macros` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hd_macros_org_idx` ON `hd_macros` (`org_id`);
