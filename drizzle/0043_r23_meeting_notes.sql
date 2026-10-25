CREATE TABLE `meeting_action_items` (
	`org_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`item_key` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `meeting_id`, `item_key`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
