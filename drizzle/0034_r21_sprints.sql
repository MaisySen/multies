CREATE TABLE `sprints` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`carried_over` integer DEFAULT 0 NOT NULL,
	`snapshot` text DEFAULT '{}' NOT NULL,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `sprints_org_project_idx` ON `sprints` (`org_id`,`project_id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `sprint_id` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `points` real;
--> statement-breakpoint
CREATE INDEX `tasks_sprint_idx` ON `tasks` (`sprint_id`) WHERE "tasks"."sprint_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` ADD `estimate_unit` text DEFAULT 'points' NOT NULL;
