-- T1F (Nov 1): global search under load. Each search group reads its newest matches first; without an index in that
-- order the database read every row of the workspace and sorted them before taking the first few. These indexes let
-- it walk newest first and stop as soon as it has enough. Additive only, no data change.
CREATE INDEX IF NOT EXISTS `messages_org_date_idx` ON `messages` (`org_id`,`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_org_updated_live_idx` ON `tasks` (`org_id`,`updated_at`) WHERE "tasks"."deleted_at" IS NULL AND "tasks"."triage_state" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contacts_org_recent_live_idx` ON `contacts` (`org_id`,coalesce("last_contact_at", "updated_at")) WHERE "contacts"."deleted_at" IS NULL;
