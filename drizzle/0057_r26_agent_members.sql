-- DF-3 (R26): AI agent members can be paused, carry an avatar colour and link an existing agent inbox.
-- All nullable, no index: read with the member row that People, the team list and API key checks already load.
ALTER TABLE `members` ADD `disabled_at` integer;--> statement-breakpoint
ALTER TABLE `members` ADD `avatar_color` text;--> statement-breakpoint
ALTER TABLE `members` ADD `linked_agent_id` text;
