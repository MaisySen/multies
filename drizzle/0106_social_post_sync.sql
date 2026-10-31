-- Oct 31: posts checked against their network, and deleted there from Multies. Additive only.
ALTER TABLE `social_post_targets` ADD `remote_id` text;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD `network_state` text;--> statement-breakpoint
ALTER TABLE `social_post_targets` ADD `checked_at` integer;
