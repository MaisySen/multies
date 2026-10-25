CREATE TABLE `mail_thread_state` (
	`org_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`assignee_user_id` text,
	`assigned_by` text,
	`assigned_at` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`done_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `thread_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `mail_thread_state_assignee_idx` ON `mail_thread_state` (`org_id`,`assignee_user_id`) WHERE "mail_thread_state"."assignee_user_id" IS NOT NULL;
