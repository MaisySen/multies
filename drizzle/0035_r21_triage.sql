ALTER TABLE `tasks` ADD `triage_state` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `triage_source` text;
--> statement-breakpoint
ALTER TABLE `projects` ADD `triage` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `forms` ADD `triage` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `tasks_org_triage_idx` ON `tasks` (`org_id`,`created_at`) WHERE "tasks"."triage_state" IS NOT NULL;
