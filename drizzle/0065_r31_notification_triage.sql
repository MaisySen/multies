-- R31: notification triage and catch-up. A notification can be marked done or snoozed until a time. The Inbox, Later
-- and Done reads use the existing notifications_user_idx (user_id, org_id, created_at) and filter the two new columns
-- on that person's rows; no new index on notifications, so a notification insert still costs the same D1 writes
-- (tests/write-cost.test.ts). item_visits keeps one row per person and item (chat channel, task, doc) with the last
-- time they caught up, written at most once a minute per item.
ALTER TABLE `notifications` ADD `done_at` integer;--> statement-breakpoint
ALTER TABLE `notifications` ADD `snoozed_until` integer;--> statement-breakpoint
CREATE TABLE `item_visits` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`last_visit_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `item_type`, `item_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
