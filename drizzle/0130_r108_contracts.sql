-- R108: contracts. Workspace contract templates (built from a standard one), a clause library with versions, and a record of generated contracts. Additive only.
CREATE TABLE `contract_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`base_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`clause_keys` text DEFAULT '[]' NOT NULL,
	`retired_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contract_templates_org_idx` ON `contract_templates` (`org_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `contract_clauses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`retired_at` integer,
	`created_by` text,
	`created_by_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_clauses_version_uq` ON `contract_clauses` (`org_id`,`key`,`version`);
--> statement-breakpoint
CREATE TABLE `contract_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`template_id` text NOT NULL,
	`title` text NOT NULL,
	`doc_id` text,
	`answers` text DEFAULT '{}' NOT NULL,
	`clause_versions` text DEFAULT '{}' NOT NULL,
	`task_ids` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contract_runs_mine_idx` ON `contract_runs` (`org_id`,`created_by`,`created_at`);
