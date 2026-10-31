-- R120: client portal. A login free space per contact or company: shared files (kept files store), docs and tasks the
-- workspace chooses, R88 file requests, a messages thread, and email link sign in with its own scoped session.
-- Additive only.
CREATE TABLE `client_portals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`contact_id` text,
	`company_id` text,
	`welcome` text,
	`show_brand` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_client_at` integer,
	`team_seen_at` integer,
	`team_notified_at` integer,
	`client_notified_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_portals_key_idx` ON `client_portals` (`key`);
--> statement-breakpoint
CREATE INDEX `client_portals_org_idx` ON `client_portals` (`org_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `client_portals_contact_idx` ON `client_portals` (`org_id`, `contact_id`);
--> statement-breakpoint
CREATE INDEX `client_portals_company_idx` ON `client_portals` (`org_id`, `company_id`);
--> statement-breakpoint
CREATE TABLE `client_portal_people` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_id` text NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`contact_id` text,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_portal_people_email_idx` ON `client_portal_people` (`portal_id`, `email`);
--> statement-breakpoint
CREATE TABLE `client_portal_items` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_id` text NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`title` text NOT NULL,
	`folder` text,
	`bytes` integer,
	`content_type` text,
	`token_enc` text,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE INDEX `client_portal_items_portal_idx` ON `client_portal_items` (`portal_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `client_portal_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`portal_id` text NOT NULL,
	`org_id` text NOT NULL,
	`from_client` integer NOT NULL,
	`user_id` text,
	`person_id` text,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `client_portal_messages_portal_idx` ON `client_portal_messages` (`portal_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `client_portal_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`portal_id` text NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `client_portal_links_person_idx` ON `client_portal_links` (`person_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `client_portal_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`portal_id` text NOT NULL,
	`person_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `client_portal_sessions_person_idx` ON `client_portal_sessions` (`person_id`);
