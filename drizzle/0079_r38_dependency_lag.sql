-- R38 (dependencies round 2): lead and lag per "blocks" link, and per project schedule rules.
-- entity_links.lag_days: whole days on a task dependency link. Positive is a wait after the blocker ends (lag),
-- negative lets the blocked task start that many days before (lead). 0 for every existing row.
ALTER TABLE `entity_links` ADD `lag_days` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- board_settings.schedule: JSON { workingDaysOnly, daysOff: [0..6], strict } for the project's timeline.
-- '{}' means the defaults (calendar days, flexible moves). One upsert per change (essential: a person saved it).
ALTER TABLE `board_settings` ADD `schedule` text DEFAULT '{}' NOT NULL;
