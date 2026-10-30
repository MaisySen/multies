-- R25 API speed: two composite indexes that REPLACE existing ones, so a row insert writes the same number of index rows as before.
-- messages: the inbox list filters on org and folder and sorts by date; (org_id) alone made it read every message in the workspace.
DROP INDEX IF EXISTS `messages_org_idx`;--> statement-breakpoint
CREATE INDEX `messages_org_folder_date_idx` ON `messages` (`org_id`,`folder`,`date`);--> statement-breakpoint
-- tasks: the same leading columns as tasks_org_project_idx plus status, deleted_at and triage_state, so the per project counts
-- (projects list, sidebar) are answered from the index alone instead of reading every task row.
DROP INDEX IF EXISTS `tasks_org_project_idx`;--> statement-breakpoint
CREATE INDEX `tasks_org_project_cover_idx` ON `tasks` (`org_id`,`project_id`,`status_id`,`position`,`status`,`deleted_at`,`triage_state`);
