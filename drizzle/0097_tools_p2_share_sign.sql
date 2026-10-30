-- Tools P2 (H5): secure share links and e-sign. Files themselves live in Workers KV with their own expiry
-- (deps.toolFiles, no R2); D1 holds the small rows: a ledger of every kept file (live bytes per workspace
-- and in total are capped from it), share links with their download log, and signing requests with their
-- signers and the signing record (events). Every table carries org_id and an index for each query.
CREATE TABLE `tool_files` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`bytes` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_files_org_live_idx` ON `tool_files` (`org_id`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `tool_files_expiry_idx` ON `tool_files` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `tool_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`token_hash` text NOT NULL,
	`file_id` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`source` text NOT NULL,
	`password_hash` text,
	`max_downloads` integer,
	`downloads` integer DEFAULT 0 NOT NULL,
	`wrong_tries` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`notify_first` integer DEFAULT 0 NOT NULL,
	`notified_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_shares_token_idx` ON `tool_shares` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `tool_shares_org_idx` ON `tool_shares` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `tool_share_downloads` (
	`id` text PRIMARY KEY NOT NULL,
	`share_id` text NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	`country` text,
	`agent` text
);
--> statement-breakpoint
CREATE INDEX `tool_share_downloads_share_idx` ON `tool_share_downloads` (`share_id`,`at`);
--> statement-breakpoint
CREATE INDEX `tool_share_downloads_org_idx` ON `tool_share_downloads` (`org_id`);
--> statement-breakpoint
CREATE TABLE `sign_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title` text NOT NULL,
	`subject` text,
	`message` text,
	`mailbox_id` text,
	`in_reply_to_id` text,
	`order_mode` text DEFAULT 'any' NOT NULL,
	`fields` text,
	`pages` text,
	`source_file_id` text NOT NULL,
	`source_sha256` text NOT NULL,
	`final_file_id` text,
	`final_sha256` text,
	`engine_job` text,
	`engine_kind` text,
	`remind_days` integer DEFAULT 0 NOT NULL,
	`error` text,
	`expires_at` integer NOT NULL,
	`sent_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sign_requests_org_idx` ON `sign_requests` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `sign_requests_status_idx` ON `sign_requests` (`status`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `sign_signers` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`org_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text,
	`status` text NOT NULL,
	`sent_at` integer,
	`reminded_at` integer,
	`viewed_at` integer,
	`signed_at` integer,
	`declined_at` integer,
	`decline_reason` text,
	`signature_file_ids` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sign_signers_token_idx` ON `sign_signers` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sign_signers_request_idx` ON `sign_signers` (`request_id`,`position`);
--> statement-breakpoint
CREATE TABLE `sign_events` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`org_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`signer_id` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`action` text NOT NULL,
	`ip_country` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `sign_events_request_idx` ON `sign_events` (`request_id`,`seq`);
