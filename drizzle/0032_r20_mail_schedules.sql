CREATE TABLE `mail_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`thread_id` text,
	`message_id` text,
	`due_at` integer NOT NULL,
	`payload` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `mail_schedules_due_idx` ON `mail_schedules` (`status`,`due_at`);
