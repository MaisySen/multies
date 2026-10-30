CREATE TABLE `aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`address` text NOT NULL,
	`destinations` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aliases_address_uq` ON `aliases` (`address`);--> statement-breakpoint
CREATE INDEX `aliases_org_idx` ON `aliases` (`org_id`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_b64` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_user_id` text,
	`actor_email` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata` text,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_org_idx` ON `audit_logs` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`message_id` text,
	`direction` text NOT NULL,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`provider_message_id` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_org_idx` ON `deliveries` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`verification_token` text NOT NULL,
	`dkim_selector` text NOT NULL,
	`dkim_public_key` text NOT NULL,
	`dkim_private_key_enc` text NOT NULL,
	`last_check` text,
	`last_checked_at` integer,
	`verified_at` integer,
	`catch_all_mailbox_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_name_uq` ON `domains` (`name`);--> statement-breakpoint
CREATE INDEX `domains_org_idx` ON `domains` (`org_id`);--> statement-breakpoint
CREATE TABLE `inbound_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`secret_enc` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbound_keys_org_idx` ON `inbound_keys` (`org_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`local_part` text NOT NULL,
	`address` text NOT NULL,
	`display_name` text NOT NULL,
	`quota_mb` integer NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_uq` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE INDEX `mailboxes_org_idx` ON `mailboxes` (`org_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`folder` text NOT NULL,
	`message_id_header` text,
	`in_reply_to` text,
	`references_header` text,
	`thread_id` text NOT NULL,
	`from_address` text NOT NULL,
	`from_name` text DEFAULT '' NOT NULL,
	`to_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`bcc_json` text DEFAULT '[]' NOT NULL,
	`reply_to` text,
	`subject` text DEFAULT '' NOT NULL,
	`text_body` text DEFAULT '' NOT NULL,
	`html_body` text,
	`snippet` text DEFAULT '' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`is_starred` integer DEFAULT false NOT NULL,
	`has_attachments` integer DEFAULT false NOT NULL,
	`auth_results` text,
	`date` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_mailbox_folder_idx` ON `messages` (`mailbox_id`,`folder`,`date`);--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_org_idx` ON `messages` (`org_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'starter' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_agent` text,
	`ip` text,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);