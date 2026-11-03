CREATE TABLE `social_pages` (
	`org_id` text NOT NULL,
	`app` text NOT NULL,
	`page_id` text NOT NULL,
	`key` text NOT NULL,
	`via_account_id` text NOT NULL,
	`name` text,
	`picture_url` text,
	`state` text DEFAULT 'ok' NOT NULL,
	`added_by` text,
	`added_at` integer NOT NULL,
	`checked_at` integer,
	PRIMARY KEY(`org_id`, `app`, `page_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_pages_key_uq` ON `social_pages` (`org_id`,`key`);--> statement-breakpoint
CREATE INDEX `social_pages_via_idx` ON `social_pages` (`org_id`,`via_account_id`);
