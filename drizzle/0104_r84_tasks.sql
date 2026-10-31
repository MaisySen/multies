-- R84: tasks round. Additive only.
-- saved_views: a view can be pinned as a tab on Tasks (shared views for everyone, private ones for their owner), in order.
-- tasks.co_assignees: people beside the main assignee (assignee_id), as JSON ["member:<id>", "agent:<id>"], so lists
-- read no other table for them. workspace_tags: the workspace's tags with their colours; tasks.labels keeps the names.
-- custom_fields.workspace_key: a field defined once for the workspace is kept as one row per project with the same key
-- and the same option ids, so values, filters, formulas and the project tables keep working per project.
ALTER TABLE `saved_views` ADD `pinned` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `saved_views` ADD `position` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `co_assignees` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TABLE `workspace_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_tags_org_name_uq` ON `workspace_tags` (`org_id`,`name`);
--> statement-breakpoint
ALTER TABLE `custom_fields` ADD `workspace_key` text;
--> statement-breakpoint
CREATE INDEX `custom_fields_workspace_key_idx` ON `custom_fields` (`org_id`,`workspace_key`) WHERE `workspace_key` IS NOT NULL;
