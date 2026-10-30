-- R39 page history: saved states of a doc (title and content) so a person or an agent can see and restore an earlier page.
-- One row per doc per editing session at most (deferrable); the newest 50 unnamed rows per doc are kept, named rows always.
CREATE TABLE `doc_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`doc_version` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`author_type` text DEFAULT 'member' NOT NULL,
	`author_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT 'edit' NOT NULL,
	`name` text,
	`saved_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_id`) REFERENCES `docs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `doc_versions_doc_idx` ON `doc_versions` (`doc_id`,`created_at`);
