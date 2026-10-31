-- R107 (Oct 31): e-sign upgrade. Additive only: new columns, two tables, one index, one trigger.
-- Identity codes per signer, a richer append only signing record, a per workspace seal key, templates and bulk send.
ALTER TABLE `sign_requests` ADD `v2` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sign_requests` ADD `seal` text;--> statement-breakpoint
ALTER TABLE `sign_requests` ADD `seal_key_id` text;--> statement-breakpoint
ALTER TABLE `sign_requests` ADD `template_id` text;--> statement-breakpoint
ALTER TABLE `sign_requests` ADD `bulk_id` text;--> statement-breakpoint
ALTER TABLE `sign_requests` ADD `pending_send` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sign_requests_pending_idx` ON `sign_requests` (`pending_send`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sign_requests_final_sha_idx` ON `sign_requests` (`final_sha256`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sign_requests_template_idx` ON `sign_requests` (`template_id`);--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `code_hash` text;--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `code_expires_at` integer;--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `code_tries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `code_sent_at` integer;--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `code_sends` text;--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `sign_signers` ADD `verified_token` text;--> statement-breakpoint
ALTER TABLE `sign_events` ADD `ip_hash` text;--> statement-breakpoint
ALTER TABLE `sign_events` ADD `user_agent` text;--> statement-breakpoint
ALTER TABLE `sign_events` ADD `tz` text;--> statement-breakpoint
ALTER TABLE `sign_events` ADD `doc_sha256` text;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sign_events_append_only` BEFORE UPDATE ON `sign_events` BEGIN SELECT RAISE(ABORT, 'sign_events is append only'); END;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `esign_keys` (
	`org_id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_enc` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sign_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`order_mode` text DEFAULT 'any' NOT NULL,
	`remind_days` integer DEFAULT 0 NOT NULL,
	`expires_days` integer DEFAULT 14 NOT NULL,
	`roles` text NOT NULL,
	`fields` text NOT NULL,
	`pages` text NOT NULL,
	`source_file_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sign_templates_org_idx` ON `sign_templates` (`org_id`,`deleted_at`,`updated_at`);
