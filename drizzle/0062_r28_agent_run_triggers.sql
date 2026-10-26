-- R28 (DF-3 slice 3): triggers that queue agent runs on a schedule or from a signed inbound webhook. One row per
-- trigger (at most 20 per workspace). The cron pass finds due schedule triggers through a partial index that only
-- holds enabled schedule rows, so firing writes the run row plus one trigger row update. ADR 0008, "Slice 3".
CREATE TABLE `agent_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`task_id` text,
	`project_id` text,
	`title_template` text,
	`instructions` text,
	`every_hours` integer,
	`daily_at` text,
	`days` text,
	`timezone` text NOT NULL,
	`next_run_at` integer,
	`secret_enc` text,
	`secret_hint` text,
	`last_hook_ts` integer,
	`last_fired_at` integer,
	`fire_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_triggers_org_idx` ON `agent_triggers` (`org_id`);--> statement-breakpoint
CREATE INDEX `agent_triggers_due_idx` ON `agent_triggers` (`next_run_at`) WHERE "agent_triggers"."enabled" = 1 AND "agent_triggers"."kind" = 'schedule';--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `trigger_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `input` text;--> statement-breakpoint
CREATE INDEX `agent_runs_queued_idx` ON `agent_runs` (`agent_user_id`) WHERE "agent_runs"."status" = 'queued';
