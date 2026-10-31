-- R85: inbox tabs (a person's tab style and the senders and threads they moved to a tab), mail rules with several
-- actions in order, a run log per rule, and thread labels. Additive only: existing people keep their tabs until they
-- choose another style.
ALTER TABLE `mail_prefs` ADD `inbox_tabs` text;
--> statement-breakpoint
ALTER TABLE `mail_prefs` ADD `tab_pins` text;
--> statement-breakpoint
CREATE TABLE `mail_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`match` text DEFAULT 'all' NOT NULL,
	`conditions` text DEFAULT '[]' NOT NULL,
	`actions` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_rules_mailbox_idx` ON `mail_rules` (`mailbox_id`,`enabled`);
--> statement-breakpoint
CREATE INDEX `mail_rules_user_idx` ON `mail_rules` (`org_id`,`user_id`,`position`);
--> statement-breakpoint
CREATE TABLE `mail_rule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`message_id` text,
	`from_address` text,
	`subject` text,
	`status` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `mail_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_rule_runs_rule_idx` ON `mail_rule_runs` (`rule_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `mail_thread_labels` (
	`org_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`label` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `thread_id`, `label`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `mail_thread_labels_label_idx` ON `mail_thread_labels` (`org_id`,`label`);
