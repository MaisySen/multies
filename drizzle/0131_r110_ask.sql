-- R110: Ask across the workspace. Each person's own questions and answers (private to them), the change cards an
-- answer proposes (nothing changes until the person clicks Apply) and their saved prompts. Additive only.
CREATE TABLE `ask_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ask_threads_user_idx` ON `ask_threads` (`org_id`,`user_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `ask_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`sources` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `ask_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ask_messages_thread_idx` ON `ask_messages` (`thread_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ask_messages_user_idx` ON `ask_messages` (`org_id`,`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `ask_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `ask_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ask_cards_message_idx` ON `ask_cards` (`message_id`);
--> statement-breakpoint
CREATE TABLE `ask_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ask_prompts_user_idx` ON `ask_prompts` (`org_id`,`user_id`);
