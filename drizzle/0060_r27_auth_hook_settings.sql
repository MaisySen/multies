ALTER TABLE `auth_email_hooks` ADD `enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_email_hooks` ADD `sender_name` text;--> statement-breakpoint
ALTER TABLE `auth_email_hooks` ADD `test_sends` text;
