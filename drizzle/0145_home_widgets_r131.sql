-- R131 (Nov 2): Home widgets. One layout per person per workspace, plus the workspace default (user_id ''). Additive only.
CREATE TABLE IF NOT EXISTS `home_layouts` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`layout` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
