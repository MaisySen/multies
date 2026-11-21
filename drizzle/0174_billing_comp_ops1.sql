-- OPS1: a plain summary on processed billing events, and an end date and note for an operator's comp.
ALTER TABLE `billing_events` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `comp_until` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `comp_note` text;
