-- Tools P2 (automation): auto rules before sending, saved workflows, document templates and mail merge.
-- Every table carries org_id; each query the code runs has an index (primary keys cover the per org reads).

-- Auto rules before sending. user_id '' is the workspace default (admins); a person's own row overrides
-- each rule where its column is not NULL. compress/word_pdf: 'on' | 'off' | NULL (follow the workspace).
CREATE TABLE `tool_send_rules` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`compress` text,
	`compress_over_mb` integer,
	`word_pdf` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`)
) WITHOUT ROWID;
--> statement-breakpoint
-- Saved workflows: 2 to 6 Tools steps run by the engine as one chain job. steps is JSON [{"op","options"}].
CREATE TABLE `tool_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`finish` text DEFAULT 'download' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_workflows_org_idx` ON `tool_workflows` (`org_id`, `updated_at`);
--> statement-breakpoint
-- Workspace document templates (HTML with {{field}} placeholders; fields is JSON [{"key","label","type"}]).
-- The three built in templates live in code and are not stored.
CREATE TABLE `tool_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`name` text NOT NULL,
	`html` text NOT NULL,
	`fields` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_templates_org_idx` ON `tool_templates` (`org_id`, `updated_at`);
--> statement-breakpoint
-- Mail merge runs: one personal PDF and one email per person. status: rendering | sending | done | cancelled | failed.
CREATE TABLE `merge_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`template_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`marketing` integer DEFAULT 0 NOT NULL,
	`consent_at` integer NOT NULL,
	`total` integer NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`engine_job` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `merge_runs_org_idx` ON `merge_runs` (`org_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `merge_runs_status_idx` ON `merge_runs` (`status`, `updated_at`);
--> statement-breakpoint
-- One row per person in a run. data is the person's field values (JSON). status: queued | sent | failed | skipped.
CREATE TABLE `merge_recipients` (
	`run_id` text NOT NULL,
	`idx` integer NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`sent_at` integer,
	PRIMARY KEY(`run_id`, `idx`)
) WITHOUT ROWID;
--> statement-breakpoint
-- The mail merge daily cap: people reserved per workspace per UTC day, taken in one conditional upsert.
CREATE TABLE `merge_daily` (
	`org_id` text NOT NULL,
	`day` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `day`)
) WITHOUT ROWID;
--> statement-breakpoint
-- People who unsubscribed from a workspace's mail merge sends (marketing runs skip them).
CREATE TABLE `merge_unsubscribes` (
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `email`)
) WITHOUT ROWID;
