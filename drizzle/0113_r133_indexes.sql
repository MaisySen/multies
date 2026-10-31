-- R133 (Oct 31): two read paths scanned the whole table. Additive only.
-- The org's statuses (read cache, every Tasks page) and a thread's snoozes and reminders (every mail thread).
CREATE INDEX IF NOT EXISTS `project_statuses_org_idx` ON `project_statuses` (`org_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mail_schedules_thread_idx` ON `mail_schedules` (`mailbox_id`,`thread_id`);
