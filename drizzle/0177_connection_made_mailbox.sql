-- Wave 1 review V4: whether a connection made its own mailbox (1) or took over a kept one (0: a copy kept for a legal
-- hold after its connection was removed). Dropping a connection that never got its emailed code (P60) removes only a
-- mailbox it made. 0 on existing rows, so nothing made before this is ever removed by that path; old code never reads it.
ALTER TABLE `mail_connections` ADD `made_mailbox` integer DEFAULT 0 NOT NULL;
