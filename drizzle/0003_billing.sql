CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`org_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `stripe_subscription_id` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `subscription_status` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `current_period_end` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `cancel_at_period_end` integer DEFAULT false NOT NULL;