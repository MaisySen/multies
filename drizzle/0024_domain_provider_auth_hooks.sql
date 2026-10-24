CREATE TABLE `auth_email_hooks` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`kind` text DEFAULT 'supabase' NOT NULL,
	`secret_enc` text NOT NULL,
	`supabase_url` text NOT NULL,
	`app_name` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_email_hooks_org_idx` ON `auth_email_hooks` (`org_id`);--> statement-breakpoint
ALTER TABLE `domains` ADD `provider_domain_id` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `provider_records` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `provider_status` text;