-- TD7 Forms pro B: brand kit, close date, response cap, password (hash only), save and resume, views and completion
-- counts without cookies. Additive only; nothing reads these tables while FORMS_TD7 is off.
CREATE TABLE `form_pro_td7` (
	`form_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`password_hash` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `form_pro_td7_org_idx` ON `form_pro_td7` (`org_id`);
--> statement-breakpoint
CREATE TABLE `form_partials_td7` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`form_id` text NOT NULL,
	`answers` text DEFAULT '{}' NOT NULL,
	`answered` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `form_partials_td7_form_idx` ON `form_partials_td7` (`form_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `form_partials_td7_exp_idx` ON `form_partials_td7` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `form_stats_td7` (
	`form_id` text NOT NULL,
	`day` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`starts` integer DEFAULT 0 NOT NULL,
	`completions` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`form_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `form_reach_td7` (
	`form_id` text NOT NULL,
	`field_id` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`form_id`, `field_id`)
);
