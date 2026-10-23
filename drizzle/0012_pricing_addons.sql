CREATE TABLE `org_addons` (
	`org_id` text NOT NULL,
	`addon_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `addon_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`org_id` text NOT NULL,
	`period` text NOT NULL,
	`metric` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`org_id`, `period`, `metric`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `kind` text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `billing_interval` text;