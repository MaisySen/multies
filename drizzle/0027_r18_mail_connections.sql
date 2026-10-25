CREATE TABLE `mail_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`username` text NOT NULL,
	`imap_host` text NOT NULL,
	`imap_port` integer NOT NULL,
	`imap_security` text NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer NOT NULL,
	`smtp_security` text NOT NULL,
	`auth_kind` text DEFAULT 'password' NOT NULL,
	`secret_enc` text NOT NULL,
	`saves_sent` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`last_sync_at` integer,
	`next_sync_at` integer,
	`initial_done` integer DEFAULT false NOT NULL,
	`sync_state` text DEFAULT '{}' NOT NULL,
	`messages_synced` integer DEFAULT 0 NOT NULL,
	`messages_today` integer DEFAULT 0 NOT NULL,
	`day` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_connections_mailbox_uq` ON `mail_connections` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `mail_connections_org_idx` ON `mail_connections` (`org_id`);--> statement-breakpoint
CREATE INDEX `mail_connections_due_idx` ON `mail_connections` (`status`,`next_sync_at`);--> statement-breakpoint
CREATE TABLE `mail_sync_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`remote_box` text NOT NULL,
	`remote_uid` integer NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `mail_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_sync_outbox_conn_idx` ON `mail_sync_outbox` (`connection_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `remote_box` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `remote_uid` integer;--> statement-breakpoint
CREATE INDEX `messages_mailbox_msgid_idx` ON `messages` (`mailbox_id`,`message_id_header`);