CREATE TABLE `thread_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`author_type` text DEFAULT 'member' NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `thread_comments_thread_idx` ON `thread_comments` (`org_id`,`thread_id`,`created_at`);
