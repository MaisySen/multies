ALTER TABLE `messages` ADD `provider_message_id_header` text;--> statement-breakpoint
CREATE INDEX `messages_mailbox_provider_msgid_idx` ON `messages` (`mailbox_id`,`provider_message_id_header`);