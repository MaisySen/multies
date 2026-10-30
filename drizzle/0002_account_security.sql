CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`data` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_uq` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_user_idx` ON `auth_tokens` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_user_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret_enc` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_pending_enc` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `password_changed_at` integer;