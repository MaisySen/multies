ALTER TABLE `meetings` ADD `recurrence` text;--> statement-breakpoint
ALTER TABLE `meetings` ADD `recurrence_tz` text;--> statement-breakpoint
ALTER TABLE `members` ADD `kind` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `title` text;--> statement-breakpoint
ALTER TABLE `members` ADD `bio` text;