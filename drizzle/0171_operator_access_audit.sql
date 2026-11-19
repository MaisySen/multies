CREATE TABLE IF NOT EXISTS `operator_access_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('role_change', 'sessions_revoked')),
  `actor_id` text NOT NULL,
  `target_id` text NOT NULL,
  `observed_operator` integer NOT NULL,
  `requested_operator` integer,
  `requested_at` integer NOT NULL,
  `outcome` text NOT NULL DEFAULT 'pending' CHECK (`outcome` IN ('pending', 'applied', 'unconfirmed')),
  `finished_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operator_access_audit_target_at_idx` ON `operator_access_audit` (`target_id`, `requested_at`);
