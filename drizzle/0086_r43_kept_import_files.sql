-- R43 imports that finish after the page closes: the run row points at its kept upload (Workers KV), how many parts it
-- has, what the scheduled pass needs besides the file, and when the kept file expires (7 days at most).
ALTER TABLE `data_moves` ADD `file_key` text;--> statement-breakpoint
ALTER TABLE `data_moves` ADD `file_parts` integer;--> statement-breakpoint
ALTER TABLE `data_moves` ADD `file_meta` text;--> statement-breakpoint
ALTER TABLE `data_moves` ADD `file_expires_at` integer;
