CREATE TABLE `chat_reactions` (
	`message_id` text NOT NULL,
	`reactor` text NOT NULL,
	`emoji` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `reactor`, `emoji`),
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
