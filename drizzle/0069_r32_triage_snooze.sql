-- R32: a Triage item can be snoozed until a time (it leaves the queue and its count, then comes back by itself),
-- and remembers why it was declined and which task it duplicates. New columns only, no backfill.
ALTER TABLE `tasks` ADD `triage_snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `triage_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `duplicate_of` text;
