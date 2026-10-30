CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`client_uri` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text DEFAULT 'read' NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_hash` text,
	`code_challenge` text,
	`code_expires_at` integer,
	`code_used_at` integer,
	`refresh_hash` text,
	`refresh_expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_org_idx` ON `oauth_grants` (`org_id`,`user_id`);