ALTER TABLE `organizations` ADD `timezone` text DEFAULT 'Australia/Sydney' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `country` text DEFAULT 'AU' NOT NULL;