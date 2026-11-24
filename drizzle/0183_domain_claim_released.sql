-- Wave 3 review Y1: a claim never verified is released 45 days after it was added even when a mailbox on it holds mail
-- or settings. The row stays (its mailboxes need it), renamed to a non-routable name under .invalid; released_name keeps
-- the name it held and released_at when. Null on every existing row; old code never reads them.
ALTER TABLE `domains` ADD `released_name` text;--> statement-breakpoint
ALTER TABLE `domains` ADD `released_at` integer;
