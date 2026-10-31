-- R91 Dashboards plus: public links, emailed reports, alerts, data sources. Additive only.
CREATE TABLE `dashboard_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`dashboard_id` text NOT NULL REFERENCES `dashboards`(`id`) ON DELETE cascade,
	`token_hash` text NOT NULL,
	`password_hash` text,
	`show_brand` integer DEFAULT true NOT NULL,
	`purpose` text DEFAULT 'link' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`snapshot` text,
	`snapshot_at` integer
);--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_shares_token_uq` ON `dashboard_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `dashboard_shares_dash_idx` ON `dashboard_shares` (`dashboard_id`);--> statement-breakpoint
CREATE TABLE `dashboard_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`dashboard_id` text NOT NULL REFERENCES `dashboards`(`id`) ON DELETE cascade,
	`created_by` text NOT NULL,
	`frequency` text NOT NULL,
	`hour` integer DEFAULT 8 NOT NULL,
	`weekday` integer,
	`month_day` integer,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`with_pdf` integer DEFAULT true NOT NULL,
	`recipients` text DEFAULT '[]' NOT NULL,
	`unsubscribed` text DEFAULT '[]' NOT NULL,
	`share_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `dashboard_reports_due_idx` ON `dashboard_reports` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `dashboard_reports_dash_idx` ON `dashboard_reports` (`dashboard_id`);--> statement-breakpoint
CREATE TABLE `dashboard_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`dashboard_id` text NOT NULL REFERENCES `dashboards`(`id`) ON DELETE cascade,
	`widget_id` text NOT NULL,
	`created_by` text NOT NULL,
	`direction` text NOT NULL,
	`threshold` real NOT NULL,
	`by_mail` integer DEFAULT true NOT NULL,
	`quiet_start` integer,
	`quiet_end` integer,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`state` text,
	`pending` integer DEFAULT false NOT NULL,
	`last_value` real,
	`last_fired_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`next_check_at` integer NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `dashboard_alerts_due_idx` ON `dashboard_alerts` (`enabled`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `dashboard_alerts_dash_idx` ON `dashboard_alerts` (`dashboard_id`);--> statement-breakpoint
CREATE TABLE `dashboard_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url` text,
	`refresh` text DEFAULT 'manual' NOT NULL,
	`columns` text DEFAULT '[]' NOT NULL,
	`rows` text DEFAULT '[]' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`refreshed_at` integer,
	`next_refresh_at` integer,
	`last_error` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `dashboard_sources_org_idx` ON `dashboard_sources` (`org_id`);--> statement-breakpoint
CREATE INDEX `dashboard_sources_due_idx` ON `dashboard_sources` (`next_refresh_at`);
