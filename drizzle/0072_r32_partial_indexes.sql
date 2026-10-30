-- R32 (D1 write budget): seven indexes on columns that are empty for most rows become partial (WHERE col IS NOT NULL).
-- D1 bills every index entry a write touches. A full index holds a NULL entry for every row, so each insert paid for
-- an entry no query reads: tasks without a parent or a source thread, chat messages that are not replies, inbound
-- deliveries and received messages without a provider id, contacts without a company, tasks without a due date. Every query on these columns
-- compares them to a value (=, IN, <, >=), which SQLite proves implies IS NOT NULL, so the same reads use the partial
-- index (EXPLAIN QUERY PLAN checked in tests/write-budget-r32.test.ts). Building them writes one entry per non NULL row.
DROP INDEX IF EXISTS `tasks_parent_idx`;--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_id`) WHERE "tasks"."parent_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_org_thread_idx`;--> statement-breakpoint
CREATE INDEX `tasks_org_thread_idx` ON `tasks` (`org_id`,`thread_id`) WHERE "tasks"."thread_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `chat_messages_parent_idx`;--> statement-breakpoint
CREATE INDEX `chat_messages_parent_idx` ON `chat_messages` (`parent_id`) WHERE "chat_messages"."parent_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `deliveries_provider_msg_idx`;--> statement-breakpoint
CREATE INDEX `deliveries_provider_msg_idx` ON `deliveries` (`provider_message_id`) WHERE "deliveries"."provider_message_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `messages_mailbox_provider_msgid_idx`;--> statement-breakpoint
CREATE INDEX `messages_mailbox_provider_msgid_idx` ON `messages` (`mailbox_id`,`provider_message_id_header`) WHERE "messages"."provider_message_id_header" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `contacts_company_idx`;--> statement-breakpoint
CREATE INDEX `contacts_company_idx` ON `contacts` (`company_id`) WHERE "contacts"."company_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_org_due_idx`;--> statement-breakpoint
CREATE INDEX `tasks_org_due_idx` ON `tasks` (`org_id`,`due_at`) WHERE "tasks"."due_at" IS NOT NULL;
