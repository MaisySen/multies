-- TD6 One inbox: remembered Important or Noise choices per sender or source, and per person state (read, done, snoozed)
-- for mail and assistant items (ids and state only; no subjects or bodies). Index for the assistant replies read. Additive only.
CREATE TABLE `inbox_lane_rules_td6` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`lane` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`, `key`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `inbox_item_state_td6` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`read` integer,
	`done_at` integer,
	`snoozed_until` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`, `kind`, `ref_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_creator_td6_idx` ON `agent_runs` (`org_id`, `created_by_user_id`, `finished_at`);
