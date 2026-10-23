-- Move authentication to Better Auth. Passwords carry over (same PBKDF2 hashes, now
-- in accounts). Sessions, pending invitations and old 2FA enrolments are reset.
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
INSERT INTO `accounts` (`id`, `account_id`, `provider_id`, `user_id`, `password`, `created_at`, `updated_at`)
  SELECT 'acc_' || lower(hex(randomblob(10))), `id`, 'credential', `id`, `password_hash`, `created_at`, `created_at` FROM `users`;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `image` text;--> statement-breakpoint
ALTER TABLE `users` ADD `two_factor_enabled` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `users` ADD `role` text;--> statement-breakpoint
ALTER TABLE `users` ADD `banned` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `users` ADD `ban_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `ban_expires` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `users` SET `email_verified` = (`email_verified_at` IS NOT NULL), `updated_at` = `created_at`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `password_hash`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `email_verified_at`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `totp_secret_enc`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `totp_pending_enc`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `totp_enabled_at`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `totp_last_step`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `password_changed_at`;--> statement-breakpoint
ALTER TABLE `organizations` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `logo` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `metadata` text;--> statement-breakpoint
UPDATE `organizations` SET `slug` = `id`;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_uq` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_org_user_uq` ON `members` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `members_user_idx` ON `members` (`user_id`);--> statement-breakpoint
INSERT INTO `members` (`id`, `organization_id`, `user_id`, `role`, `created_at`)
  SELECT 'mem_' || lower(hex(randomblob(10))), `org_id`, `user_id`, `role`, `created_at` FROM `memberships`;--> statement-breakpoint
DROP TABLE `memberships`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`active_organization_id` text,
	`impersonated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_uq` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
DROP TABLE `invitations`;--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`inviter_id` text NOT NULL,
	`mailbox_ids` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitations_org_idx` ON `invitations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `two_factors` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factors_user_idx` ON `two_factors` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_key_uq` ON `rate_limits` (`key`);--> statement-breakpoint
DROP TABLE `auth_tokens`;--> statement-breakpoint
DROP TABLE `recovery_codes`;
