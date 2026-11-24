-- W6 (round 2): a connection folded into another waits to be removed (a removal-pending marker row) while the platform
-- refuses the removal. This keeps when that started, so a connection whose kept one is gone and whose removal has
-- failed for a week is shown to admins again to disconnect by hand. Null on every existing row; old code never reads it.
ALTER TABLE `social_account_profiles` ADD `removal_failed_since` integer;
