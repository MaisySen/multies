-- Wave 2 review X1: an agent key reaches a personal mailbox only when the person who minted it in their own app session
-- owns that mailbox. This column records that person; null means no person session minted it (a workspace key, a
-- connected AI app, or a key the audit log can't prove), and such a key reaches no personal mailbox. Old code never
-- reads it.
ALTER TABLE `api_keys` ADD `minted_by_user_id` text;--> statement-breakpoint
-- Backfill, only where the audit log proves a person session minted the key: the key made together with its agent,
-- when the agent.created row says via "app" (no API key or connected app behind the request) and the same person wrote
-- the agent.key_created row for this key within 10 seconds, with no key or connected app stamp on it (AIS1 caller). A key minted later from Agents carries no such proof
-- (its audit row reads the same for a person and a connected AI app), so it stays null and loses personal mailbox
-- access until its maker mints a new one. Idempotent.
UPDATE `api_keys` SET `minted_by_user_id` = (
  SELECT c.`actor_user_id` FROM `audit_logs` c
  JOIN `audit_logs` k ON k.`org_id` = c.`org_id` AND k.`agent_id` = c.`agent_id` AND k.`action` = 'agent.key_created'
    AND k.`target_id` = `api_keys`.`id` AND k.`actor_user_id` = c.`actor_user_id` AND abs(k.`created_at` - c.`created_at`) <= 10000
    AND k.`actor_email` NOT LIKE 'api-key:%' AND coalesce(k.`metadata`, '') NOT LIKE '%"caller":%'
  WHERE c.`org_id` = `api_keys`.`org_id` AND c.`agent_id` = `api_keys`.`agent_id` AND c.`action` = 'agent.created'
    AND c.`actor_user_id` IS NOT NULL AND c.`actor_user_id` = `api_keys`.`created_by_user_id`
    AND c.`actor_email` NOT LIKE 'api-key:%' AND c.`metadata` LIKE '%"via":"app"%'
  LIMIT 1
)
WHERE `agent_id` IS NOT NULL AND `minted_by_user_id` IS NULL;--> statement-breakpoint
-- Agents an API key made before Wave 1 review V2 kept the key's maker as their maker, so they reach her personal
-- mailboxes. Their agent_mailbox_access rows to personal mailboxes go, and they have no maker any more (as an agent a
-- key makes today). Idempotent.
DELETE FROM `agent_mailbox_access` WHERE `agent_id` IN (
  SELECT `agent_id` FROM `audit_logs` WHERE `action` = 'agent.created' AND `actor_email` LIKE 'api-key:%' AND `agent_id` IS NOT NULL
) AND `mailbox_id` IN (SELECT `id` FROM `mailboxes` WHERE `personal` = 1);--> statement-breakpoint
UPDATE `agents` SET `created_by_user_id` = NULL WHERE `created_by_user_id` IS NOT NULL AND `id` IN (
  SELECT `agent_id` FROM `audit_logs` WHERE `action` = 'agent.created' AND `actor_email` LIKE 'api-key:%' AND `agent_id` IS NOT NULL
);
