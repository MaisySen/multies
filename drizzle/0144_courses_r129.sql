-- R129 (Nov 1): courses, a doc type (docs.kind "course"). Settings per course, lessons (quiz keys stay on the server),
-- learners (assigned or self started) and progress per lesson. Additive only: new tables and indexes.
CREATE TABLE IF NOT EXISTS `doc_courses` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`pass_mark` integer DEFAULT 80 NOT NULL,
	`certificate` integer DEFAULT true NOT NULL,
	`editors` text DEFAULT '[]' NOT NULL,
	`managers` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `doc_courses_org_idx` ON `doc_courses` (`org_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `course_lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`ref_doc_id` text,
	`url` text,
	`body` text DEFAULT '' NOT NULL,
	`quiz` text DEFAULT '[]' NOT NULL,
	`pass_mark` integer,
	`required` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `course_lessons_doc_idx` ON `course_lessons` (`org_id`,`doc_id`,`position`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `course_learners` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source` text DEFAULT 'self' NOT NULL,
	`assigned_by` text,
	`due_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`certificate_no` text,
	`reminded_soon_at` integer,
	`reminded_overdue_at` integer,
	`removed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `course_learners_uq` ON `course_learners` (`org_id`,`doc_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `course_learners_user_idx` ON `course_learners` (`org_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `course_learners_due_idx` ON `course_learners` (`due_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `course_progress` (
	`learner_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`org_id` text NOT NULL,
	`done_at` integer,
	`score` integer,
	`best_score` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attempt_day` text,
	`day_attempts` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT false NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`learner_id`, `lesson_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
