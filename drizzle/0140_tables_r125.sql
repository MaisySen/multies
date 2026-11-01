-- R125: tables, a doc type (docs.kind "table"). A row per table in doc_tables, its fields, rows (cells as JSON) and views.
-- Row comments ride doc_comments with a new row_id. Additive only.
CREATE TABLE `doc_tables` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`edit_access` text DEFAULT 'everyone' NOT NULL,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_tables_org_idx` ON `doc_tables` (`org_id`);--> statement-breakpoint
CREATE TABLE `table_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`width` integer,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `table_fields_doc_idx` ON `table_fields` (`org_id`,`doc_id`,`position`);--> statement-breakpoint
CREATE TABLE `table_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`seq` integer NOT NULL,
	`position` real NOT NULL,
	`cells` text DEFAULT '{}' NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_by` text,
	`updated_at` integer,
	`deleted_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `table_rows_doc_pos_idx` ON `table_rows` (`org_id`,`doc_id`,`position`);--> statement-breakpoint
CREATE INDEX `table_rows_doc_seq_idx` ON `table_rows` (`org_id`,`doc_id`,`seq`);--> statement-breakpoint
CREATE TABLE `table_views` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `table_views_doc_idx` ON `table_views` (`org_id`,`doc_id`,`position`);--> statement-breakpoint
ALTER TABLE `doc_comments` ADD `row_id` text;--> statement-breakpoint
CREATE INDEX `doc_comments_row_idx` ON `doc_comments` (`org_id`,`row_id`,`created_at`) WHERE "doc_comments"."row_id" IS NOT NULL;
