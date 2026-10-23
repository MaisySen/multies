CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`mailbox_ids` text DEFAULT '[]' NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`invited_by_name` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_uq` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitations_org_idx` ON `invitations` (`org_id`);--> statement-breakpoint
CREATE TABLE `mailbox_access` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `mailbox_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_access_org_idx` ON `mailbox_access` (`org_id`);