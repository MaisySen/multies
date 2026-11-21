-- OPS1: the platform audit log for operator actions (console and /api/admin). Append only, no foreign keys.
CREATE TABLE `platform_audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_email` text,
	`actor_role` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`org_id` text,
	`reason` text,
	`before` text,
	`after` text,
	`metadata` text,
	`ip` text,
	`user_agent` text,
	`request_id` text,
	`impersonation_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `platform_audit_created_idx` ON `platform_audit_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX `platform_audit_actor_idx` ON `platform_audit_logs` (`actor_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `platform_audit_org_idx` ON `platform_audit_logs` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `platform_audit_target_idx` ON `platform_audit_logs` (`target_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `platform_audit_action_idx` ON `platform_audit_logs` (`action`,`created_at`);
