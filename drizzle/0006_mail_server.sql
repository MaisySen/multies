CREATE TABLE `app_passwords` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`server_credential_id` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `app_passwords_mailbox_idx` ON `app_passwords` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `app_passwords_org_idx` ON `app_passwords` (`org_id`);--> statement-breakpoint
CREATE TABLE `mail_server_accounts` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`server_account_id` text NOT NULL,
	`secret_enc` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_server_accounts_org_idx` ON `mail_server_accounts` (`org_id`);