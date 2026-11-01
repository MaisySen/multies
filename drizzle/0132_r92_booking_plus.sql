-- R92: Booking plus. Resources with booking rules and QR check in, group time polls, free events with RSVP tickets,
-- and the spam shield's spent challenges. Additive only.
CREATE TABLE `booking_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'room' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`capacity` integer,
	`timezone` text NOT NULL,
	`days` text NOT NULL,
	`open_from` text DEFAULT '08:00' NOT NULL,
	`open_to` text DEFAULT '18:00' NOT NULL,
	`step_min` integer DEFAULT 30 NOT NULL,
	`min_min` integer DEFAULT 30 NOT NULL,
	`max_min` integer DEFAULT 240 NOT NULL,
	`quota_min_week` integer,
	`needs_approval` integer DEFAULT false NOT NULL,
	`checkin_required` integer DEFAULT false NOT NULL,
	`release_after_min` integer DEFAULT 15 NOT NULL,
	`checkin_key` text NOT NULL,
	`created_by` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `booking_resources_org_idx` ON `booking_resources` (`org_id`);
--> statement-breakpoint
CREATE TABLE `resource_bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_name` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`checked_in_at` integer,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `booking_resources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `resource_bookings_res_idx` ON `resource_bookings` (`resource_id`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `resource_bookings_org_idx` ON `resource_bookings` (`org_id`,`status`,`starts_at`);
--> statement-breakpoint
CREATE INDEX `resource_bookings_user_idx` ON `resource_bookings` (`org_id`,`user_id`,`starts_at`);
--> statement-breakpoint
CREATE TABLE `time_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`token` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`duration_min` integer DEFAULT 30 NOT NULL,
	`timezone` text NOT NULL,
	`video` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`winner_option_id` text,
	`meeting_id` text,
	`deadline_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `time_polls_token_uq` ON `time_polls` (`token`);
--> statement-breakpoint
CREATE INDEX `time_polls_org_idx` ON `time_polls` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `time_poll_options` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `time_polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `time_poll_options_poll_idx` ON `time_poll_options` (`poll_id`,`starts_at`);
--> statement-breakpoint
CREATE TABLE `time_poll_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`answers` text NOT NULL,
	`edit_token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `time_polls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `time_poll_votes_poll_idx` ON `time_poll_votes` (`poll_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `booking_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`online_url` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`capacity` integer,
	`waitlist` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`going_count` integer DEFAULT 0 NOT NULL,
	`waitlist_count` integer DEFAULT 0 NOT NULL,
	`checked_in_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booking_events_slug_uq` ON `booking_events` (`slug`);
--> statement-breakpoint
CREATE INDEX `booking_events_org_idx` ON `booking_events` (`org_id`,`starts_at`);
--> statement-breakpoint
CREATE TABLE `event_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`status` text NOT NULL,
	`code_hash` text NOT NULL,
	`checked_in_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `booking_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_tickets_email_uq` ON `event_tickets` (`event_id`,`email`);
--> statement-breakpoint
CREATE INDEX `event_tickets_code_idx` ON `event_tickets` (`event_id`,`code_hash`);
--> statement-breakpoint
CREATE INDEX `event_tickets_status_idx` ON `event_tickets` (`event_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `shield_spent` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shield_spent_exp_idx` ON `shield_spent` (`expires_at`);
