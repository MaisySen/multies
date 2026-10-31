-- R122: help center (public knowledge base and Q&A). Additive only. Public pages read only rows a workspace published.
CREATE TABLE `hc_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`on` integer DEFAULT 0 NOT NULL,
	`slug` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`intro` text DEFAULT '' NOT NULL,
	`qa_on` integer DEFAULT 1 NOT NULL,
	`moderate` integer DEFAULT 1 NOT NULL,
	`suggest_in_chat` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hc_settings_slug_uq` ON `hc_settings` (`slug`);
--> statement-breakpoint
CREATE TABLE `hc_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hc_categories_slug_uq` ON `hc_categories` (`org_id`,`slug`);
--> statement-breakpoint
CREATE TABLE `hc_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`category_id` text,
	`doc_id` text,
	`doc_version` integer,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`helpful_yes` integer DEFAULT 0 NOT NULL,
	`helpful_no` integer DEFAULT 0 NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hc_articles_slug_uq` ON `hc_articles` (`org_id`,`slug`);
--> statement-breakpoint
CREATE INDEX `hc_articles_org_status_idx` ON `hc_articles` (`org_id`,`status`,`category_id`,`position`);
--> statement-breakpoint
CREATE INDEX `hc_articles_doc_idx` ON `hc_articles` (`org_id`,`doc_id`);
--> statement-breakpoint
CREATE TABLE `hc_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`category_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`author_name` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'public' NOT NULL,
	`ticket_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`answer_count` integer DEFAULT 0 NOT NULL,
	`accepted_answer_id` text,
	`visitor_hash` text,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hc_questions_org_status_idx` ON `hc_questions` (`org_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `hc_questions_org_votes_idx` ON `hc_questions` (`org_id`,`status`,`votes`);
--> statement-breakpoint
CREATE TABLE `hc_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`question_id` text NOT NULL,
	`body` text NOT NULL,
	`author_kind` text DEFAULT 'visitor' NOT NULL,
	`author_user_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`visitor_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `hc_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hc_answers_question_idx` ON `hc_answers` (`question_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `hc_answers_org_status_idx` ON `hc_answers` (`org_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `hc_votes` (
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`voter_hash` text NOT NULL,
	`value` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `item_id`, `voter_hash`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `hc_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`article_id` text NOT NULL,
	`helpful` integer NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `hc_articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hc_feedback_org_idx` ON `hc_feedback` (`org_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `hc_terms` (
	`org_id` text NOT NULL,
	`term` text NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`weight` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`org_id`, `term`, `kind`, `item_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hc_terms_item_idx` ON `hc_terms` (`item_id`);
