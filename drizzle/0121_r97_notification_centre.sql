-- R97 (Oct 31): notification centre. Additive only: delivery settings (quiet hours, pause, digest) per person per
-- workspace, and the digest clock so the cron pass reads only rows that are due.
ALTER TABLE `notification_prefs` ADD `delivery` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `digest_due_at` integer;--> statement-breakpoint
ALTER TABLE `notification_prefs` ADD `digest_last_at` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `notification_prefs_digest_idx` ON `notification_prefs` (`digest_due_at`);
