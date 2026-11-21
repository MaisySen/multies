-- OPS1: indexes for the operator console's cross-workspace lists (newest first, by status, in a time window).
CREATE INDEX IF NOT EXISTS `deliveries_status_created_idx` ON `deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `deliveries_direction_created_idx` ON `deliveries` (`direction`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suppressions_created_idx` ON `suppressions` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `webhook_deliveries_status_created_idx` ON `webhook_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_grants_created_idx` ON `oauth_grants` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_grants_client_idx` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_clients_created_idx` ON `oauth_clients` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_jobs_created_idx` ON `import_jobs` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_runs_status_created_idx` ON `agent_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `send_approvals_status_created_idx` ON `send_approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `data_moves_created_idx` ON `data_moves` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `usage_counters_period_metric_idx` ON `usage_counters` (`period`,`metric`,`count`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `users_created_idx` ON `users` (`created_at`);
