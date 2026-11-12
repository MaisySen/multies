-- QUAL1 (audit rows 12, 14): the provider's last refusal of a workspace's own AI key, so Settings, Team AI and the mail
-- assistant show the real state. Both columns are null while the key works; old code never reads them.
ALTER TABLE `ai_keys` ADD `problem` text;--> statement-breakpoint
ALTER TABLE `ai_keys` ADD `problem_at` integer;
