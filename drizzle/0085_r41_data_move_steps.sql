-- R41 move your data: each step of an import writes last_step_at, so a scheduled pass can find runs left behind (the page
-- closed part way) through one small index instead of scanning data_moves. notified_at records the one email a run
-- sends when it finishes or is paused by that pass, so it is never sent twice.
ALTER TABLE `data_moves` ADD `last_step_at` integer;--> statement-breakpoint
ALTER TABLE `data_moves` ADD `notified_at` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_moves_status_step_idx` ON `data_moves` (`status`,`last_step_at`);
