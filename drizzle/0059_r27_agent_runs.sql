-- R27 (DF-3 slice 2): an AI agent member's run on a task: start, ordered steps, result. One table with the steps as a
-- JSON array, so appending a step is one row update (no index touched). Starting writes the row plus two index
-- entries; finishing writes the row and drops it from the partial index. ADR 0008, "Slice 2: agent runs".
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_user_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`result` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`step_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_task_idx` ON `agent_runs` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_active_uq` ON `agent_runs` (`task_id`,`agent_user_id`) WHERE "agent_runs"."status" IN ('queued', 'running');
