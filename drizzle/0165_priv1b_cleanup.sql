-- PRIV1b (P24): member grants on mailboxes 0164 made personal mean nothing now (the owner shares those) and made every Team access edit fail.
DELETE FROM `mailbox_access` WHERE `mailbox_id` IN (SELECT `id` FROM `mailboxes` WHERE `personal` = 1);--> statement-breakpoint
-- PRIV1b (P24): shares end when the person or the mailbox owner left the workspace before leaving ended them.
DELETE FROM `mailbox_delegations` WHERE NOT EXISTS (SELECT 1 FROM `members` m WHERE m.`organization_id` = `mailbox_delegations`.`org_id` AND m.`user_id` = `mailbox_delegations`.`user_id`) OR NOT EXISTS (SELECT 1 FROM `mailboxes` b JOIN `members` m ON m.`organization_id` = b.`org_id` AND m.`user_id` = b.`owner_user_id` WHERE b.`id` = `mailbox_delegations`.`mailbox_id`);--> statement-breakpoint
-- PRIV1b (P32): workspace deletion (cascade) and the retention prune find a workspace's rows without a scan.
CREATE INDEX `mailbox_access_log_org_idx` ON `mailbox_access_log` (`org_id`,`created_at`);
