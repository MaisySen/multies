-- R26 (MB-85): checklist items inside a task. One row per item; one index on task_id (the task panel and the
-- card chips read by task). A tick or rename writes one row plus that index. No index on tasks changes.
CREATE TABLE `task_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`assignee` text,
	`due` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_checklist_items_task_idx` ON `task_checklist_items` (`task_id`);
