ALTER TABLE `mailboxes` ADD `personal` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `owner_user_id` text;--> statement-breakpoint
CREATE INDEX `mailboxes_personal_idx` ON `mailboxes` (`org_id`,`owner_user_id`) WHERE "mailboxes"."personal" = 1;--> statement-breakpoint
ALTER TABLE `organizations` ADD `comp_plan` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `mailbox_delegations` (
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text NOT NULL,
	`granted_by_user_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_delegations_user_idx` ON `mailbox_delegations` (`org_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `mailbox_access_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`actor_user_id` text,
	`actor_email` text,
	`action` text NOT NULL,
	`target_id` text,
	`device` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mailbox_access_log_mailbox_idx` ON `mailbox_access_log` (`mailbox_id`,`created_at`);--> statement-breakpoint
UPDATE `mailboxes` SET `personal` = 1 WHERE `kind` = 'person' AND `personal` = 0 AND `id` IN (SELECT `mailbox_id` FROM `mail_connections`);--> statement-breakpoint
UPDATE `mailboxes` SET `personal` = 1 WHERE `kind` = 'person' AND `personal` = 0 AND `id` IN (SELECT `target_id` FROM `audit_logs` WHERE `action` = 'free_address.claimed' AND `target_type` = 'mailbox');--> statement-breakpoint
UPDATE `mailboxes` SET `owner_user_id` = (SELECT c.`created_by_user_id` FROM `mail_connections` c JOIN `members` m ON m.`user_id` = c.`created_by_user_id` AND m.`organization_id` = c.`org_id` WHERE c.`mailbox_id` = `mailboxes`.`id` ORDER BY c.`created_at` LIMIT 1) WHERE `personal` = 1 AND `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `mailboxes` SET `owner_user_id` = (SELECT a.`actor_user_id` FROM `audit_logs` a JOIN `members` m ON m.`user_id` = a.`actor_user_id` AND m.`organization_id` = a.`org_id` WHERE a.`action` = 'free_address.claimed' AND a.`target_type` = 'mailbox' AND a.`target_id` = `mailboxes`.`id` ORDER BY a.`created_at` LIMIT 1) WHERE `personal` = 1 AND `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `mailboxes` SET `owner_user_id` = (SELECT x.`user_id` FROM `mailbox_access` x JOIN `members` m ON m.`user_id` = x.`user_id` AND m.`organization_id` = x.`org_id` WHERE x.`mailbox_id` = `mailboxes`.`id`) WHERE `personal` = 1 AND `owner_user_id` IS NULL AND (SELECT count(*) FROM `mailbox_access` x WHERE x.`mailbox_id` = `mailboxes`.`id`) = 1;--> statement-breakpoint
UPDATE `organizations` SET `comp_plan` = 1 WHERE `id` = 'org_14tjeedzlvi8epm3';
