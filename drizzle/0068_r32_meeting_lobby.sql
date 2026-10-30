-- R32: a meeting's waiting room. Guests from outside the workspace ask to join and wait until a member admits them.
-- guest_lobby: the meeting setting "Guests wait to be let in" (on by default, existing meetings included).
ALTER TABLE `meetings` ADD `guest_lobby` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TABLE `meeting_lobby` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`org_id` text NOT NULL,
	`guest_name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `meeting_lobby_meeting_idx` ON `meeting_lobby` (`meeting_id`,`status`);
