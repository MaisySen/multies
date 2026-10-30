CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`provider` text NOT NULL,
	`source_host` text NOT NULL,
	`source_port` integer DEFAULT 993 NOT NULL,
	`source_user` text NOT NULL,
	`secret_enc` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`messages_done` integer DEFAULT 0 NOT NULL,
	`messages_total` integer,
	`error` text,
	`created_by_user_id` text,
	`claimed_at` integer,
	`heartbeat_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_jobs_org_idx` ON `import_jobs` (`org_id`);--> statement-breakpoint
CREATE INDEX `import_jobs_status_idx` ON `import_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`tenant_id` text,
	`tenant_name` text,
	`tokens_enc` text NOT NULL,
	`expires_at` integer,
	`connected_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_org_provider_uq` ON `integrations` (`org_id`,`provider`);