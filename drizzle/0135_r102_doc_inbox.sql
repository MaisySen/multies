-- R102 (Nov 1): Smart document inbox (DOC_INBOX_R102). Additive only. One row per drive file that is read (text in the
-- index database doc_fts, rowid = doc_inbox.id), the workspace's matching rules, and the per workspace daily count.
CREATE TABLE IF NOT EXISTS `doc_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` text NOT NULL,
	`org_id` text NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`mail_attachment_id` text,
	`added_by` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`job_id` text,
	`tries` integer DEFAULT 0 NOT NULL,
	`version_id` text,
	`doc_type` text,
	`sender` text,
	`doc_date` text,
	`due_date` text,
	`amount` integer,
	`gst` integer,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`paid` integer DEFAULT 0 NOT NULL,
	`edited` text DEFAULT '' NOT NULL,
	`rules` text DEFAULT '' NOT NULL,
	`checked` integer DEFAULT 0 NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `doc_inbox_item_uq` ON `doc_inbox` (`item_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_inbox_org_status_idx` ON `doc_inbox` (`org_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_inbox_org_created_idx` ON `doc_inbox` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `doc_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`match` text NOT NULL,
	`pattern` text NOT NULL,
	`case_sensitive` integer DEFAULT 0 NOT NULL,
	`set_tags` text DEFAULT '' NOT NULL,
	`set_sender` text,
	`set_type` text,
	`set_folder_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_rules_org_idx` ON `doc_rules` (`org_id`,`position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `doc_inbox_state` (
	`org_id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
