-- R62 (pricing): Business storage drops from 2,500 GB to 1,000 GB for new Business workspaces. The ones that exist
-- keep 2,500 GB (2,560,000 MB) through legacy_storage_mb, which only counts while the workspace stays on Business.
ALTER TABLE `organizations` ADD `legacy_storage_mb` integer;--> statement-breakpoint
UPDATE `organizations` SET `legacy_storage_mb` = 2560000 WHERE `plan` = 'business';--> statement-breakpoint
-- R62: each workspace's referral code, made the first time an owner opens the referral link in Billing.
ALTER TABLE `organizations` ADD `referral_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_referral_code_uq` ON `organizations` (`referral_code`) WHERE `referral_code` IS NOT NULL;--> statement-breakpoint
-- R62: one row per workspace that signed up through a referral link. status: signed_up (no payment yet), pending (first
-- payment made, waiting out the refund window), credited, blocked (self referral or over the cap) or void (refunded).
CREATE TABLE `referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`referrer_org_id` text NOT NULL,
	`referred_org_id` text NOT NULL,
	`code` text NOT NULL,
	`status` text DEFAULT 'signed_up' NOT NULL,
	`reason` text,
	`invoice_id` text,
	`paid_at` integer,
	`eligible_at` integer,
	`credited_at` integer,
	`referrer_credit_cents` integer DEFAULT 0 NOT NULL,
	`referred_credit_cents` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `referrals_referred_uq` ON `referrals` (`referred_org_id`);--> statement-breakpoint
CREATE INDEX `referrals_referrer_idx` ON `referrals` (`referrer_org_id`,`status`,`credited_at`);
