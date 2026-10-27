-- R48: per project task counts (todo, doing, done) for the project list, read from this summary (one row per project
-- and status) instead of a group by over every live task of the workspace (about 63k rows read on prod as isolates
-- warmed after a deploy). Triggers on tasks keep it: a task that becomes live adds one to its bucket, one that stops
-- being live (deleted, sent to triage) or moves project or status takes one from the old bucket. A recount per write
-- would read every task of the project (1,000 rows on the big test project) on each status change; this reads one row.
CREATE TABLE `project_status_counts` (
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `project_id`, `status`)
);--> statement-breakpoint
INSERT INTO `project_status_counts` (`org_id`, `project_id`, `status`, `n`) SELECT `org_id`, `project_id`, `status`, count(*) FROM `tasks` WHERE `deleted_at` IS NULL AND `triage_state` IS NULL GROUP BY `org_id`, `project_id`, `status`;--> statement-breakpoint
CREATE TRIGGER `tasks_project_counts_ai` AFTER INSERT ON `tasks` WHEN NEW.`deleted_at` IS NULL AND NEW.`triage_state` IS NULL BEGIN INSERT INTO `project_status_counts` (`org_id`, `project_id`, `status`, `n`) VALUES (NEW.`org_id`, NEW.`project_id`, NEW.`status`, 1) ON CONFLICT (`org_id`, `project_id`, `status`) DO UPDATE SET `n` = `n` + 1; END;--> statement-breakpoint
CREATE TRIGGER `tasks_project_counts_ad` AFTER DELETE ON `tasks` WHEN OLD.`deleted_at` IS NULL AND OLD.`triage_state` IS NULL BEGIN UPDATE `project_status_counts` SET `n` = max(`n` - 1, 0) WHERE `org_id` = OLD.`org_id` AND `project_id` = OLD.`project_id` AND `status` = OLD.`status`; END;--> statement-breakpoint
CREATE TRIGGER `tasks_project_counts_au_old` AFTER UPDATE OF `project_id`, `status`, `deleted_at`, `triage_state` ON `tasks` WHEN OLD.`deleted_at` IS NULL AND OLD.`triage_state` IS NULL AND (NOT (NEW.`deleted_at` IS NULL AND NEW.`triage_state` IS NULL) OR (NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`status` IS NOT OLD.`status`)) BEGIN UPDATE `project_status_counts` SET `n` = max(`n` - 1, 0) WHERE `org_id` = OLD.`org_id` AND `project_id` = OLD.`project_id` AND `status` = OLD.`status`; END;--> statement-breakpoint
CREATE TRIGGER `tasks_project_counts_au_new` AFTER UPDATE OF `project_id`, `status`, `deleted_at`, `triage_state` ON `tasks` WHEN NEW.`deleted_at` IS NULL AND NEW.`triage_state` IS NULL AND (NOT (OLD.`deleted_at` IS NULL AND OLD.`triage_state` IS NULL) OR (NEW.`project_id` IS NOT OLD.`project_id` OR NEW.`status` IS NOT OLD.`status`)) BEGIN INSERT INTO `project_status_counts` (`org_id`, `project_id`, `status`, `n`) VALUES (NEW.`org_id`, NEW.`project_id`, NEW.`status`, 1) ON CONFLICT (`org_id`, `project_id`, `status`) DO UPDATE SET `n` = `n` + 1; END;
