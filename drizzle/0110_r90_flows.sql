-- R90 (Oct 31): automation builder. Flows, their runs and steps, page and feed watches, digest items. Additive only.
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`trigger_kind` text NOT NULL,
	`graph` text DEFAULT '{"nodes":[],"edges":[]}' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`created_by_type` text DEFAULT 'member' NOT NULL,
	`created_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `flows_org_trigger_idx` ON `flows` (`org_id`,`trigger_kind`,`enabled`);--> statement-breakpoint
CREATE TABLE `flow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`dedupe_key` text NOT NULL,
	`trigger_data` text DEFAULT '{}' NOT NULL,
	`current_node` text,
	`resume_at` integer,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flow_runs_dedupe_idx` ON `flow_runs` (`flow_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `flow_runs_due_idx` ON `flow_runs` (`status`,`resume_at`);--> statement-breakpoint
CREATE INDEX `flow_runs_org_idx` ON `flow_runs` (`org_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `flow_runs_flow_idx` ON `flow_runs` (`flow_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `flow_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`kind` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `flow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flow_run_steps_once_idx` ON `flow_run_steps` (`run_id`,`node_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `flow_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`selector` text,
	`every_minutes` integer DEFAULT 360 NOT NULL,
	`next_check_at` integer,
	`last_checked_at` integer,
	`last_hash` text,
	`last_text` text,
	`seen` text DEFAULT '[]' NOT NULL,
	`last_error` text,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flow_watches_flow_idx` ON `flow_watches` (`flow_id`);--> statement-breakpoint
CREATE INDEX `flow_watches_due_idx` ON `flow_watches` (`next_check_at`);--> statement-breakpoint
CREATE TABLE `flow_digest_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`node_id` text NOT NULL,
	`title` text NOT NULL,
	`link` text,
	`summary` text,
	`send_at` integer NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `flow_digest_due_idx` ON `flow_digest_items` (`sent_at`,`send_at`);--> statement-breakpoint
CREATE INDEX `flow_digest_flow_idx` ON `flow_digest_items` (`flow_id`,`node_id`);
