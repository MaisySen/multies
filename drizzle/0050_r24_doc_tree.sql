ALTER TABLE `docs` ADD `parent_id` text;
--> statement-breakpoint
ALTER TABLE `docs` ADD `position` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `doc_links` (
	`org_id` text NOT NULL,
	`source_doc_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`source_doc_id`, `target_type`, `target_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `doc_links_target_idx` ON `doc_links` (`target_type`,`target_id`);
