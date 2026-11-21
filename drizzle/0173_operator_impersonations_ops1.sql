-- OPS1: operator impersonations (view or act as a person), with reason and expiry.
CREATE TABLE `operator_impersonations` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_user_id` text NOT NULL,
	`operator_email` text,
	`target_user_id` text NOT NULL,
	`target_org_id` text,
	`session_id` text,
	`mode` text DEFAULT 'view' NOT NULL,
	`reason` text NOT NULL,
	`started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	`ended_reason` text
);
--> statement-breakpoint
CREATE INDEX `operator_impersonations_session_idx` ON `operator_impersonations` (`session_id`);
--> statement-breakpoint
CREATE INDEX `operator_impersonations_operator_idx` ON `operator_impersonations` (`operator_user_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `operator_impersonations_target_idx` ON `operator_impersonations` (`target_user_id`,`started_at`);
