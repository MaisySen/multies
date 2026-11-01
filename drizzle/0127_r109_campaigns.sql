-- R109: Mail merge plus. Lists with consent records, newsletters (campaigns) with per recipient stats,
-- journeys (welcome series and follow ups). Unsubscribes stay in merge_unsubscribes (one list across the
-- workspace) and bounces and complaints in suppressions. Additive only.
CREATE TABLE `audience_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`visibility` text DEFAULT 'workspace' NOT NULL,
	`owner_user_id` text NOT NULL,
	`double_opt_in` integer DEFAULT 1 NOT NULL,
	`allow_inferred` integer DEFAULT 0 NOT NULL,
	`signup_key` text NOT NULL,
	`signup_on` integer DEFAULT 0 NOT NULL,
	`mailbox_id` text,
	`sender_name` text DEFAULT '' NOT NULL,
	`sender_address` text DEFAULT '' NOT NULL,
	`tz` text DEFAULT 'Australia/Sydney' NOT NULL,
	`member_count` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audience_lists_org_idx` ON `audience_lists` (`org_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_lists_signup_key_uq` ON `audience_lists` (`signup_key`);
--> statement-breakpoint
CREATE TABLE `audience_members` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`list_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`consent_kind` text DEFAULT 'express' NOT NULL,
	`consent_source` text DEFAULT '' NOT NULL,
	`consent_at` integer,
	`confirm_token` text,
	`confirmed_at` integer,
	`unsubscribed_at` integer,
	`added_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_members_list_email_uq` ON `audience_members` (`list_id`,`email`);
--> statement-breakpoint
CREATE INDEX `audience_members_org_email_idx` ON `audience_members` (`org_id`,`email`);
--> statement-breakpoint
CREATE INDEX `audience_members_list_status_idx` ON `audience_members` (`list_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_members_confirm_uq` ON `audience_members` (`confirm_token`);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`list_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text,
	`kind` text DEFAULT 'newsletter' NOT NULL,
	`journey_id` text,
	`name` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`preheader` text DEFAULT '' NOT NULL,
	`blocks` text DEFAULT '[]' NOT NULL,
	`track` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` integer,
	`total` integer DEFAULT 0 NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`opened` integer DEFAULT 0 NOT NULL,
	`clicked` integer DEFAULT 0 NOT NULL,
	`unsubscribed` integer DEFAULT 0 NOT NULL,
	`bounced` integer DEFAULT 0 NOT NULL,
	`error` text,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaigns_org_idx` ON `campaigns` (`org_id`,`kind`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`campaign_id` text NOT NULL,
	`idx` integer NOT NULL,
	`org_id` text NOT NULL,
	`member_id` text,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`send_after` integer,
	`sent_at` integer,
	`opened_at` integer,
	`clicked_at` integer,
	PRIMARY KEY(`campaign_id`, `idx`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_recipients_token_uq` ON `campaign_recipients` (`token`);
--> statement-breakpoint
CREATE INDEX `campaign_recipients_status_idx` ON `campaign_recipients` (`campaign_id`,`status`);
--> statement-breakpoint
CREATE TABLE `journeys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`list_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`send_hour` integer DEFAULT 9 NOT NULL,
	`enrolled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journeys_org_idx` ON `journeys` (`org_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `journeys_list_idx` ON `journeys` (`list_id`,`status`);
--> statement-breakpoint
CREATE TABLE `journey_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`journey_id` text NOT NULL,
	`org_id` text NOT NULL,
	`member_id` text NOT NULL,
	`email` text NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`next_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`last_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journey_enrollments_uq` ON `journey_enrollments` (`journey_id`,`member_id`);
--> statement-breakpoint
CREATE INDEX `journey_enrollments_due_idx` ON `journey_enrollments` (`journey_id`,`status`,`next_at`);
