-- OPS1: runtime feature flag overrides. scope_id '' is global, else a workspace id. No rows: env defaults as before.
CREATE TABLE `feature_flag_overrides` (
	`key` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`note` text,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`key`, `scope_id`)
);
--> statement-breakpoint
CREATE INDEX `feature_flag_overrides_scope_idx` ON `feature_flag_overrides` (`scope_id`);
