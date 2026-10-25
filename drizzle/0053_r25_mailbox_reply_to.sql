-- MB-61 (R25): a default Reply-To per mailbox, used when a send passes no replyTo. Nullable, no index (read with the mailbox row a send already loads).
ALTER TABLE `mailboxes` ADD `reply_to` text;--> statement-breakpoint
-- DF-2 (R25): chat posts made with an API key before ae526d7 stored the author as API key "<key name>".
-- New posts already read as the agent or the workspace; this renames the stored old ones once. Writes only the matching rows.
UPDATE `chat_messages` SET `author_name` = COALESCE((SELECT `name` FROM `agents` WHERE `agents`.`id` = `chat_messages`.`author_id`), `author_name`)
  WHERE `author_type` = 'agent' AND `author_name` LIKE 'API key "%';--> statement-breakpoint
UPDATE `chat_messages` SET `author_name` = COALESCE((SELECT `name` FROM `organizations` WHERE `organizations`.`id` = `chat_messages`.`org_id`), `author_name`)
  WHERE `author_type` = 'member' AND `author_name` LIKE 'API key "%';
