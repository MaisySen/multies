-- TD3 (Nov 2): meetings to tasks. Suggested action items from a meeting's transcript or notes, each accepted
-- (one real task) or discarded by a person. Keyed by (org_id, meeting_id, id) WITHOUT ROWID so a meeting's list
-- reads the key prefix with no secondary index. Additive only.
CREATE TABLE IF NOT EXISTS `meeting_suggestions` (
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`meeting_id` text NOT NULL,
	`id` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`title` text NOT NULL,
	`quote` text,
	`assignee_type` text,
	`assignee_id` text,
	`due` text,
	`status` text DEFAULT 'open' NOT NULL,
	`task_id` text,
	`created_by` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `meeting_id`, `id`)
) WITHOUT ROWID;
