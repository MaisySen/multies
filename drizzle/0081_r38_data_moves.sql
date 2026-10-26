-- R38 (move your data): one row per import or export run, so a person can see the history, follow progress,
-- download an export through a link that expires, and undo an import (the row lists exactly what it created).
-- Writes: one insert when a run starts and one update per chunk of up to 50 items (essential: the person started it).
CREATE TABLE `data_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`file_name` text,
	`status` text DEFAULT 'running' NOT NULL,
	`project_id` text,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`created` text DEFAULT '{}' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`token_hash` text,
	`expires_at` integer,
	`error` text,
	`created_by_user_id` text,
	`created_by_email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	`undone_at` integer
);
--> statement-breakpoint
CREATE INDEX `data_moves_org_idx` ON `data_moves` (`org_id`,`created_at`);
