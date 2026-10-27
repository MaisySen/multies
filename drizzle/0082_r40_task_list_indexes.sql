-- R40 D1 reads: task lists in their default order (position, newest first) walk an index and stop at the page size,
-- instead of reading and sorting every live task of the workspace or project. Measured on production (HQ, 489 tasks):
-- a page of 50 read 927 rows, a project page of 50 read 897.
CREATE INDEX IF NOT EXISTS `tasks_org_live_pos_idx` ON `tasks` (`org_id`,`position`,`created_at` desc) WHERE "tasks"."deleted_at" IS NULL AND "tasks"."triage_state" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_org_project_live_pos_idx` ON `tasks` (`org_id`,`project_id`,`position`,`created_at` desc) WHERE "tasks"."deleted_at" IS NULL AND "tasks"."triage_state" IS NULL;
