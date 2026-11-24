-- Wave 1 review V7: when someone in the workspace last asked Multies to check a domain's DNS (Add domain, or Verify).
-- The scheduled re-check does not set it. A claim checked by a person in the last 7 days is not released. Null on
-- existing rows (so the release rule falls back to the claim's age, as before); old code never reads it.
ALTER TABLE `domains` ADD `verify_attempted_at` integer;
