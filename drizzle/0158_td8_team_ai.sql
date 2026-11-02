-- TD8 Team AI: workspace AI memory (visible notes), saved instruction sets, routines and their run log. Additive only.
CREATE TABLE `teamai_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_by` text,
	`updated_by_name` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `teamai_memory_org_idx` ON `teamai_memory` (`org_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `teamai_instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_name` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`shared` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `teamai_instructions_org_idx` ON `teamai_instructions` (`org_id`,`owner_id`);
--> statement-breakpoint
CREATE TABLE `teamai_routines` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`instruction_id` text NOT NULL,
	`trigger` text NOT NULL,
	`hour` integer DEFAULT 9 NOT NULL,
	`weekday` integer DEFAULT 1 NOT NULL,
	`form_id` text,
	`project_id` text,
	`output` text DEFAULT 'draft' NOT NULL,
	`channel_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_by_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text
);
--> statement-breakpoint
CREATE INDEX `teamai_routines_org_idx` ON `teamai_routines` (`org_id`,`trigger`,`enabled`);
--> statement-breakpoint
CREATE INDEX `teamai_routines_due_idx` ON `teamai_routines` (`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE TABLE `teamai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`routine_id` text,
	`kind` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`event_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`reason` text,
	`ai_source` text,
	`output` text DEFAULT 'none' NOT NULL,
	`result` text,
	`input` text,
	`channel_id` text,
	`message_id` text,
	`actor_id` text,
	`actor_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teamai_runs_event_uq` ON `teamai_runs` (`org_id`,`event_key`);
--> statement-breakpoint
CREATE INDEX `teamai_runs_org_idx` ON `teamai_runs` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `teamai_runs_status_idx` ON `teamai_runs` (`status`,`created_at`);
