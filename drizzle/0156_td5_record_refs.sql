-- TD5 mentions: which text mentions which record (no titles, no text). Additive only.
CREATE TABLE `record_refs` (
	`org_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`parent_type` text,
	`parent_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source_type`, `source_id`, `target_type`, `target_id`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `record_refs_target_idx` ON `record_refs` (`org_id`,`target_type`,`target_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `record_refs_parent_idx` ON `record_refs` (`org_id`,`parent_type`,`parent_id`);
