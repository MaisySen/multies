-- MPLAT-96 (D1 load): cross-tick cron lease table so two scheduled ticks never overlap even if a prior tick stalls.
CREATE TABLE IF NOT EXISTS `cron_tick_leases` (
  `name` text PRIMARY KEY NOT NULL,
  `holder` text NOT NULL,
  `expires_at` integer NOT NULL
);
