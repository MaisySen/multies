-- R32: browsers subscribed to web push (VAPID). One row per push endpoint; payloads carry a type, an id, a title and a path.
CREATE TABLE `web_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_ok_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_push_subscriptions_endpoint_unique` ON `web_push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX `web_push_subscriptions_user_idx` ON `web_push_subscriptions` (`user_id`);
