CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scope` text DEFAULT 'full' NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_uq` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_org_idx` ON `api_keys` (`org_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`response_status` integer,
	`last_error` text,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`events` text NOT NULL,
	`secret_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_org_idx` ON `webhook_endpoints` (`org_id`);