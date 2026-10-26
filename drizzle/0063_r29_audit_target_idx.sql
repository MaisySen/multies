-- R29: an agent trigger's History reads its last 50 fires and refusals from audit_logs by target_id, newest first.
-- A partial index on agent trigger rows only: the read is a bounded range read instead of a scan of the workspace's
-- audit log, and every other audit insert costs no extra D1 write. Building it writes one entry per existing agent
-- trigger audit row (a few at most, since triggers shipped in R28).
CREATE INDEX `audit_target_idx` ON `audit_logs` (`target_id`,`created_at`) WHERE "audit_logs"."target_type" = 'agent_trigger';
