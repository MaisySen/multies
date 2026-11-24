-- PRIV1b P37 (round 2, owner decision): a mailbox at a human member's sign in address receives that person's account
-- mail (password resets, sign in links), so it is that person's personal mailbox: only they (and whoever they share it
-- with) open it, not every admin. New mailboxes get this when they are made (services/addresses.ts createMailbox);
-- this converts the team mailboxes made before.
-- The rule: a team mailbox (personal = 0) of kind person whose address equals, ignoring case, the sign in address of a
-- human member of the same workspace becomes personal, owned by that member. Left as team mailboxes, because the
-- platform relies on them being open to the team: agent inboxes (kind agent), the platform's free address workspace
-- (org_platform), a mailbox that sends a workspace's sign-up emails (auth_email_hooks, which refuse a personal mailbox),
-- a domain's catch-all, and support@ and security@ (the operator inbox addresses on the company domain).
-- Wave 1 review V12: also left as team mailboxes, those in team use: granted to anyone but that member
-- (mailbox_access), or worked by an AI agent (agent_mailbox_access). Converting them would quietly take them from the
-- team. Admins see the ones left in Settings (a team mailbox at a member's sign in address) and decide.
-- support@ and security@: a migration can't read the operator settings (which domain is the company's), so it leaves
-- them on every domain; outside the operator's company domain they are listed for admins the same way, and the rule
-- applies to them when a member joins or changes to that address (services/addresses.ts applyLoginMailboxRule).
-- A converted mailbox has no grants to anyone else, so nothing is taken from anyone.
-- Idempotent; old code reads personal and owner_user_id the same way.
UPDATE `mailboxes` SET `personal` = 1, `owner_user_id` = (
  SELECT u.`id` FROM `users` u JOIN `members` m ON m.`user_id` = u.`id` AND m.`organization_id` = `mailboxes`.`org_id` AND m.`kind` = 'human'
  WHERE lower(u.`email`) = lower(`mailboxes`.`address`) LIMIT 1
)
WHERE `personal` = 0 AND `kind` = 'person' AND `org_id` <> 'org_platform'
  AND lower(`local_part`) NOT IN ('support', 'security')
  AND `id` NOT IN (SELECT `mailbox_id` FROM `auth_email_hooks`)
  AND `id` NOT IN (SELECT `catch_all_mailbox_id` FROM `domains` WHERE `catch_all_mailbox_id` IS NOT NULL)
  AND `id` NOT IN (SELECT `mailbox_id` FROM `agent_mailbox_access`)
  AND NOT EXISTS (
    SELECT 1 FROM `mailbox_access` g WHERE g.`mailbox_id` = `mailboxes`.`id` AND g.`user_id` NOT IN (
      SELECT u.`id` FROM `users` u WHERE lower(u.`email`) = lower(`mailboxes`.`address`)
    )
  )
  AND EXISTS (
    SELECT 1 FROM `users` u JOIN `members` m ON m.`user_id` = u.`id` AND m.`organization_id` = `mailboxes`.`org_id` AND m.`kind` = 'human'
    WHERE lower(u.`email`) = lower(`mailboxes`.`address`)
  );
