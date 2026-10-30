CREATE TABLE `task_watchers` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
