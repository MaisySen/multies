-- R34 (MB-186): board settings per project: swimlanes (none, assignee, epic, priority, project) and WIP limits
-- per column (status id -> { max, min }). One row per project, one write per change (essential: a person saved it).
-- WITHOUT ROWID: the primary key is the row, so there is no second index entry.
CREATE TABLE `board_settings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`swimlanes` text DEFAULT 'none' NOT NULL,
	`limits` text DEFAULT '{}' NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
