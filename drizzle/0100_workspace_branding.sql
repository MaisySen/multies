-- R77: workspace branding and personal themes. One small row per workspace (the brand as JSON), the logo images
-- (base64, 512 KB each at most, the same way attachments are kept) and each person's own accent. Plain tables
-- only; every read is by primary key.
CREATE TABLE `workspace_branding` (
	`org_id` text PRIMARY KEY NOT NULL,
	`brand` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `workspace_brand_logos` (
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`version` text NOT NULL,
	`content_b64` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `kind`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `user_themes` (
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`follow_brand` integer DEFAULT 1 NOT NULL,
	`accent` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `org_id`)
) WITHOUT ROWID;
