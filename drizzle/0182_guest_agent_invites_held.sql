-- Wave 2 review X11 (B1 leftover): before Round 2 an agent's guest invite went through its send approval queue as mail
-- from its inbox with the /g/ link in it, so the agent held a working link. Those not yet joined (status 'pending', an
-- approval_id set) lose the link and become held invites (no link, no approval), listed in the project's Guests for a
-- person to confirm, which mails a fresh link through Multies' own account mail. Their approvals still waiting are
-- rejected with a note. Guests who already joined are left alone. Idempotent; new code never sets approval_id.
UPDATE `send_approvals` SET `status` = 'rejected', `note` = 'Guest invites from an agent now wait for a person in the project''s Guests.', `decided_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `status` = 'pending' AND `id` IN (SELECT `approval_id` FROM `project_guests` WHERE `approval_id` IS NOT NULL AND `status` = 'pending');--> statement-breakpoint
UPDATE `project_guests` SET `invite_hash` = NULL, `approval_id` = NULL WHERE `approval_id` IS NOT NULL AND `status` = 'pending';
