-- R114 (Nov 1): webinar mode for meetings. Additive only. A meeting can be a webinar: people register on a public page
-- and get a personal link (stored hashed), watch the stage, ask questions, vote in the meeting's polls and chat when the
-- host allows. The questions and polls are the R96 tables; two columns let a host hide a question or type an answer.
CREATE TABLE IF NOT EXISTS `webinars` (
	`meeting_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`registration_open` integer DEFAULT 1 NOT NULL,
	`slug` text NOT NULL,
	`chat_mode` text DEFAULT 'everyone' NOT NULL,
	`qa_poll_id` text,
	`panelists` text DEFAULT '[]' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`replay_recording_id` text,
	`replay_shared` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `webinars_slug_uq` ON `webinars` (`slug`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `webinars_org_idx` ON `webinars` (`org_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `webinar_registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_key` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'registered' NOT NULL,
	`joined_at` integer,
	`last_seen_at` integer,
	`minutes_watched` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `webinar_registrations_email_uq` ON `webinar_registrations` (`meeting_id`,`email_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `webinar_registrations_token_uq` ON `webinar_registrations` (`token_hash`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `webinar_chat` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`hidden_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `webinar_chat_meeting_idx` ON `webinar_chat` (`meeting_id`,`id`);
--> statement-breakpoint
ALTER TABLE `chat_poll_items` ADD `hidden_at` integer;
--> statement-breakpoint
ALTER TABLE `chat_poll_items` ADD `answer` text;
