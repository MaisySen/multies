-- R83: own sign in for two networks (short videos and short text posts), next to the platform route. One linked
-- account per network per workspace. Tokens are encrypted with APP_SECRET before they are written. publishes keeps
-- each video sent to the short video network until the network says it is up (its webhook or a status check).
CREATE TABLE `direct_social_links` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`username` text,
	`display_name` text,
	`avatar_url` text,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text,
	`access_expires_at` integer,
	`refresh_expires_at` integer,
	`scopes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `direct_social_links_org_provider_uq` ON `direct_social_links` (`org_id`,`provider`);
--> statement-breakpoint
CREATE INDEX `direct_social_links_user_idx` ON `direct_social_links` (`provider`,`provider_user_id`);
--> statement-breakpoint
CREATE TABLE `direct_social_publishes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`publish_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`post_id` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `direct_social_publishes_org_idx` ON `direct_social_publishes` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `direct_social_publishes_pub_uq` ON `direct_social_publishes` (`provider`,`publish_id`);
