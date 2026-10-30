CREATE TABLE `abuse_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`detail` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `abuse_events_org_idx` ON `abuse_events` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `abuse_events_open_idx` ON `abuse_events` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `api_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`hits` integer NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_rate_limits_reset_idx` ON `api_rate_limits` (`reset_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_scope_key_uq` ON `idempotency_keys` (`scope`,`key`);--> statement-breakpoint
CREATE INDEX `idempotency_created_idx` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`org_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`run_at` integer NOT NULL,
	`locked_until` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `jobs_org_idx` ON `jobs` (`org_id`);--> statement-breakpoint
CREATE TABLE `login_throttle` (
	`email` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL,
	`locked_until` integer
);
--> statement-breakpoint
CREATE TABLE `uptime_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`ok` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`components` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uptime_checks_at_idx` ON `uptime_checks` (`at`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `past_due_since` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `grace_ends_at` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `usage_alerts` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `require_sso` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `suspended_at` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `suspended_reason` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `send_cap_daily` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_login_method` text;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD `consecutive_dead` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_endpoints` ADD `disabled_reason` text;