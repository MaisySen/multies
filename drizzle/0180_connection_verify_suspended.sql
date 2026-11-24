-- Wave 2 review X5: whether the wait for a connect code (P60) is what suspended the connection's mailbox, so entering
-- the code turns the mailbox back on only then, never undoing a suspend someone made while the code was pending.
-- Connections already waiting get 1 (their wait suspended the mailbox, as before this column); every other row 0.
-- Old code never reads it.
ALTER TABLE `mail_connections` ADD `verify_suspended_mailbox` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `mail_connections` SET `verify_suspended_mailbox` = 1 WHERE `status` = 'verifying';
