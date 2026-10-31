-- R88: secure share. File requests (a client uploads files to a workspace without an account, in resumable chunks),
-- secret links (the server keeps only ciphertext; the key stays in the link's fragment), a view log beside the
-- download log for share links, and link reports from public pages. Additive only.
CREATE TABLE `tool_file_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`token_hash` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`folder` text,
	`password_hash` text,
	`max_file_bytes` integer NOT NULL,
	`max_total_bytes` integer NOT NULL,
	`allowed` text DEFAULT 'any' NOT NULL,
	`max_uploads` integer,
	`uploads` integer DEFAULT 0 NOT NULL,
	`bytes_received` integer DEFAULT 0 NOT NULL,
	`keep_days` integer DEFAULT 30 NOT NULL,
	`show_brand` integer DEFAULT 1 NOT NULL,
	`notify` integer DEFAULT 1 NOT NULL,
	`notified_at` integer,
	`wrong_tries` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`reports` integer DEFAULT 0 NOT NULL,
	`last_upload_at` integer,
	`expires_at` integer NOT NULL,
	`closed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_file_requests_token_idx` ON `tool_file_requests` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `tool_file_requests_org_idx` ON `tool_file_requests` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `tool_request_files` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`upload_key_hash` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`chunk_bytes` integer NOT NULL,
	`chunks` integer NOT NULL,
	`received` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`uploader_name` text,
	`uploader_email` text,
	`note` text,
	`country` text,
	`expires_at` integer NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `tool_request_files_request_idx` ON `tool_request_files` (`request_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `tool_request_files_org_idx` ON `tool_request_files` (`org_id`);
--> statement-breakpoint
CREATE TABLE `tool_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`label` text,
	`ciphertext` text,
	`file_id` text,
	`bytes` integer NOT NULL,
	`passphrase` integer DEFAULT 0 NOT NULL,
	`max_views` integer DEFAULT 1 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`notify` integer DEFAULT 1 NOT NULL,
	`reports` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`burned_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_secrets_token_idx` ON `tool_secrets` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `tool_secrets_org_idx` ON `tool_secrets` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `tool_secret_opens` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_id` text NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	`country` text,
	`region` text,
	`agent` text
);
--> statement-breakpoint
CREATE INDEX `tool_secret_opens_secret_idx` ON `tool_secret_opens` (`secret_id`,`at`);
--> statement-breakpoint
CREATE TABLE `tool_link_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`org_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`country` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_link_reports_target_idx` ON `tool_link_reports` (`target_id`,`at`);
--> statement-breakpoint
ALTER TABLE `tool_share_downloads` ADD `kind` text DEFAULT 'download' NOT NULL;
--> statement-breakpoint
ALTER TABLE `tool_share_downloads` ADD `region` text;
--> statement-breakpoint
ALTER TABLE `tool_shares` ADD `views` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tool_shares` ADD `reports` integer DEFAULT 0 NOT NULL;
