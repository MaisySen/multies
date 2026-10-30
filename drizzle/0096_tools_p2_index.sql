-- Tools P2 (17, 16): search inside attachments and smart folders.
-- attachment_text holds one row per indexed mail attachment: its workspace and mailbox (search follows the
-- caller's mailbox scope exactly as mail does), the smart folder and the indexing state. The extracted text
-- itself is NOT here: it lives only in the separate index database (binding INDEX_DB, migrations in
-- drizzle-index/), which is rebuildable and not backed up, so this database holds no virtual table and
-- `wrangler d1 export` keeps working. "id" is an explicit integer key: the index database's rows carry it
-- as their rowid, plus the attachment id, so a hit is checked against this row before it is shown.
-- No triggers anywhere: the indexer writes both databases itself, one attachment at a time, and the
-- messages table is untouched. A row whose attachment is gone (message deleted) is hidden from search and
-- folders at once by the join on attachments, and the cron sweep deletes it here and its text there.
CREATE TABLE `attachment_text` (
	`id` integer PRIMARY KEY NOT NULL,
	`attachment_id` text NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`message_id` text NOT NULL,
	`msg_date` integer NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`job_id` text,
	`tries` integer DEFAULT 0 NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`pages_ocr` integer DEFAULT 0 NOT NULL,
	`class` text,
	`class_manual` integer DEFAULT 0 NOT NULL,
	`indexed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_text_attachment_idx` ON `attachment_text` (`attachment_id`);
--> statement-breakpoint
CREATE INDEX `attachment_text_queue_idx` ON `attachment_text` (`status`, `msg_date`);
--> statement-breakpoint
CREATE INDEX `attachment_text_org_idx` ON `attachment_text` (`org_id`, `status`, `mailbox_id`, `class`);
--> statement-breakpoint
CREATE INDEX `attachment_text_folder_idx` ON `attachment_text` (`org_id`, `class`, `msg_date`);
--> statement-breakpoint
-- One row per workspace (switch, OCR language, today's count against the daily cap) and one row "*" for the
-- indexer's own cursors (hi: highest attachment seen, lo: the backfill cursor walking down, sw: the sweep cursor over attachment_text). WITHOUT ROWID:
-- an update writes only the primary key row.
CREATE TABLE `attachment_index_state` (
	`org_id` text PRIMARY KEY NOT NULL,
	`mode` text,
	`lang` text DEFAULT 'eng' NOT NULL,
	`day` text DEFAULT '' NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	`hi` integer DEFAULT 0 NOT NULL,
	`lo` integer DEFAULT 0 NOT NULL,
	`sw` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
) WITHOUT ROWID;
