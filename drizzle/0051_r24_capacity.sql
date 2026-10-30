CREATE TABLE `workload_capacity` (
	`org_id` text NOT NULL,
	`person` text NOT NULL,
	`points` real,
	`hours` real,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `person`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
