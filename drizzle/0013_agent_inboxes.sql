CREATE TABLE `agent_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_events_org_seq_idx` ON `agent_events` (`org_id`,`seq`);--> statement-breakpoint
CREATE INDEX `agent_events_agent_seq_idx` ON `agent_events` (`agent_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agent_mailbox_access` (
	`agent_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`org_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `mailbox_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_mailbox_access_mailbox_idx` ON `agent_mailbox_access` (`mailbox_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`approval_mode` text DEFAULT 'always' NOT NULL,
	`send_cap_daily` integer DEFAULT 100 NOT NULL,
	`allowed_recipients` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_mailbox_uq` ON `agents` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `agents_org_idx` ON `agents` (`org_id`);--> statement-breakpoint
CREATE TABLE `send_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`api_key_id` text,
	`decided_by_user_id` text,
	`decided_by_email` text,
	`decided_at` integer,
	`note` text,
	`message_id` text,
	`error` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `send_approvals_org_status_idx` ON `send_approvals` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `send_approvals_agent_idx` ON `send_approvals` (`agent_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `api_keys` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `agent_id` text;--> statement-breakpoint
CREATE INDEX `audit_agent_idx` ON `audit_logs` (`agent_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `sent_by_agent_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `sent_by_user_id` text;