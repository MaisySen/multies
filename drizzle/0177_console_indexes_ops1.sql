-- OPS1: indexes for the operator console's cross-workspace lists. D1 bills every index entry as a row written, so
-- busy tables only get PARTIAL indexes holding the rare rows the console lists (failures, dead letters, pending
-- approvals); ordinary writes to them cost nothing extra. Full indexes are only on tables written once per rare event.
CREATE INDEX IF NOT EXISTS `deliveries_failed_created_idx` ON `deliveries` (`created_at`) WHERE "deliveries"."status" IN ('failed', 'rejected', 'bounced', 'complained');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runs_failed_created_idx` ON `agent_runs` (`created_at`) WHERE "agent_runs"."status" = 'failed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `send_approvals_pending_created_idx` ON `send_approvals` (`created_at`) WHERE "send_approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suppressions_created_idx` ON `suppressions` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_jobs_created_idx` ON `import_jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_moves_created_idx` ON `data_moves` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_created_idx` ON `users` (`created_at`);
