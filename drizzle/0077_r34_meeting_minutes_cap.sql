-- R34 (MB-171): operator override for call participant-minutes a month per workspace. Null means the plan's rule
-- (free: 1,000; paid: no cap). Usage itself lives in usage_counters (metric meeting_participant_minutes), one upsert per call end.
ALTER TABLE `organizations` ADD `meeting_minutes_cap` integer;
