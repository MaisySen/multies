-- DF-4 (R25): an invitation can carry the title and bio the new member starts with. Nullable, no index
-- (read with the invitation row that accepting already loads). Existing invitations keep null.
ALTER TABLE `invitations` ADD `title` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD `bio` text;
