-- PRIV1b P37 (round 2, owner decision): a mailbox at a human member's sign in address receives that person's account
-- mail (password resets, sign in links), so it is that person's personal mailbox: only they (and whoever they share it
-- with) open it, not every admin. New mailboxes get this when they are made (services/addresses.ts createMailbox);
-- this converts the team mailboxes made before.
-- The rule: a team mailbox (personal = 0) of kind person whose address equals, ignoring case, the sign in address of a
-- human member of the same workspace becomes personal, owned by that member. Left as team mailboxes, because the
-- platform relies on them being open to the team: agent inboxes (kind agent), the platform's free address workspace
-- (org_platform), a mailbox that sends a workspace's sign-up emails (auth_email_hooks, which refuse a personal mailbox),
-- a domain's catch-all, and support@ and security@ (the operator inbox addresses on the company domain).
-- Grants on a converted mailbox (mailbox_access) stay in the table but no longer open it; the owner can share it.
-- Idempotent; old code reads personal and owner_user_id the same way.
UPDATE `mailboxes` SET `personal` = 1, `owner_user_id` = (
  SELECT u.`id` FROM `users` u JOIN `members` m ON m.`user_id` = u.`id` AND m.`organization_id` = `mailboxes`.`org_id` AND m.`kind` = 'human'
  WHERE lower(u.`email`) = lower(`mailboxes`.`address`) LIMIT 1
)
WHERE `personal` = 0 AND `kind` = 'person' AND `org_id` <> 'org_platform'
  AND lower(`local_part`) NOT IN ('support', 'security')
  AND `id` NOT IN (SELECT `mailbox_id` FROM `auth_email_hooks`)
  AND `id` NOT IN (SELECT `catch_all_mailbox_id` FROM `domains` WHERE `catch_all_mailbox_id` IS NOT NULL)
  AND EXISTS (
    SELECT 1 FROM `users` u JOIN `members` m ON m.`user_id` = u.`id` AND m.`organization_id` = `mailboxes`.`org_id` AND m.`kind` = 'human'
    WHERE lower(u.`email`) = lower(`mailboxes`.`address`)
  );
