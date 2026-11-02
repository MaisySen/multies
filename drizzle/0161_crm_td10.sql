CREATE TABLE `crm_suggestions_td10` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`dedupe_key` text NOT NULL,
	`fields_json` text DEFAULT '{}' NOT NULL,
	`message_id` text,
	`message_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crm_suggestions_td10_key_uq` ON `crm_suggestions_td10` (`org_id`,`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `crm_suggestions_td10_open_idx` ON `crm_suggestions_td10` (`org_id`,`status`,`message_at`);
--> statement-breakpoint
CREATE TABLE `crm_scan_td10` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scanned_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `saved_analyses_td10` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`template` text NOT NULL,
	`filters_json` text DEFAULT '{}' NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_analyses_td10_org_idx` ON `saved_analyses_td10` (`org_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `user_prefs_td10` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`shortcuts_off` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`)
);
