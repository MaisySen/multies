-- TD2 (Nov 2): Forms pro. Form settings (progress bar, one question at a time) and files or signatures sent with a
-- public form. Bytes stay in the existing file storage; this table only holds who, where and how big. Additive only.
ALTER TABLE `forms` ADD `td2` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `form_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`form_id` text NOT NULL REFERENCES `forms`(`id`) ON DELETE cascade,
	`field_id` text NOT NULL,
	`submission_id` text,
	`kind` text DEFAULT 'file' NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`parts` integer DEFAULT 1 NOT NULL,
	`ip_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `form_uploads_sender_idx` ON `form_uploads` (`form_id`,`ip_hash`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `form_uploads_submission_idx` ON `form_uploads` (`submission_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `form_uploads_org_idx` ON `form_uploads` (`org_id`,`created_at`);
