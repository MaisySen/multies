-- OPS1: one value per platform metric per UTC day, for the operator console's trends.
CREATE TABLE `platform_metrics_daily` (
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`value` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `metric`)
);
--> statement-breakpoint
CREATE INDEX `platform_metrics_daily_metric_idx` ON `platform_metrics_daily` (`metric`,`day`);
