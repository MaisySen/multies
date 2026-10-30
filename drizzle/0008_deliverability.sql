CREATE TABLE `dmarc_records` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`source_ip` text NOT NULL,
	`count` integer NOT NULL,
	`disposition` text NOT NULL,
	`header_from` text,
	`dkim` text NOT NULL,
	`spf` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `dmarc_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dmarc_records_report_idx` ON `dmarc_records` (`report_id`);--> statement-breakpoint
CREATE TABLE `dmarc_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`domain_id` text NOT NULL,
	`reporter` text NOT NULL,
	`report_id` text NOT NULL,
	`begin_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`policy` text NOT NULL,
	`messages` integer NOT NULL,
	`passed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmarc_reports_uq` ON `dmarc_reports` (`org_id`,`reporter`,`report_id`);--> statement-breakpoint
CREATE INDEX `dmarc_reports_domain_idx` ON `dmarc_reports` (`domain_id`,`end_at`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`address` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_org_address_uq` ON `suppressions` (`org_id`,`address`);--> statement-breakpoint
CREATE INDEX `deliveries_provider_msg_idx` ON `deliveries` (`provider_message_id`);