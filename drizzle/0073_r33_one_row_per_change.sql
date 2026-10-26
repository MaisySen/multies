-- R33 (D1 write budget): two narrow writes replace two wide ones.
-- 1. One row per change. A tracked write used to add an `activity` row (row, primary key and two index entries: 4 rows
--    written) AND a `changes` row (row and one index entry: 2). The change feed row now carries the activity fields
--    (actor, verb, data), so one write serves the timeline, the sync feed and webhooks: 3 rows written (row, the
--    org/seq index and one entry in the partial entity index below). Old activity rows stay where they are and are
--    still read: the `activity_feed` view is both, old rows first in time order like before. Nothing is dropped.
ALTER TABLE `changes` ADD `actor_type` text;--> statement-breakpoint
ALTER TABLE `changes` ADD `actor_id` text;--> statement-breakpoint
ALTER TABLE `changes` ADD `actor_name` text;--> statement-breakpoint
ALTER TABLE `changes` ADD `verb` text;--> statement-breakpoint
ALTER TABLE `changes` ADD `data` text;--> statement-breakpoint
CREATE INDEX `changes_entity_idx` ON `changes` (`entity_type`,`entity_id`,`seq`) WHERE "changes"."verb" IS NOT NULL;--> statement-breakpoint
DROP VIEW IF EXISTS `activity_feed`;--> statement-breakpoint
CREATE VIEW `activity_feed` AS
  SELECT `id`, `org_id`, `actor_type`, `actor_id`, `actor_name`, `verb`, `entity_type`, `entity_id`, `data`, `created_at` FROM `activity`
  UNION ALL
  SELECT 'chg_' || `seq`, `org_id`, `actor_type`, `actor_id`, `actor_name`, `verb`, `entity_type`, `entity_id`, coalesce(`data`, '{}'), `created_at` FROM `changes` WHERE `verb` IS NOT NULL;--> statement-breakpoint
-- 2. The task number claim moves off the projects row. `UPDATE projects SET next_number = next_number + 1` rewrote the
--    wide projects row and its index entries (3 rows written) for every new or moved task. The counter now lives in a
--    narrow table with no secondary index and no rowid (1 row written per claim), filled on first use from
--    projects.next_number. projects.next_number is kept, no longer written, so a rollback still finds a sane value
--    (numbers claimed since are in project_counters; a rollback copies them back, see docs/runbooks/d1-daily-limits.md).
CREATE TABLE `project_counters` (
  `project_id` text PRIMARY KEY NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `next_number` integer NOT NULL
) WITHOUT ROWID;--> statement-breakpoint
INSERT OR IGNORE INTO `project_counters` (`project_id`, `next_number`) SELECT `id`, `next_number` FROM `projects` WHERE `next_number` > 1;;--> statement-breakpoint
-- 3. Old project keys keep working. When a project's key changes (OPS to OPR), the old key is kept here so OPS-12 still
--    opens the task (1 row written per key edit, WITHOUT ROWID, no other index), and no other project can take it.
CREATE TABLE `project_key_aliases` (
  `org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  `key` text NOT NULL,
  `project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`org_id`, `key`)
) WITHOUT ROWID;
