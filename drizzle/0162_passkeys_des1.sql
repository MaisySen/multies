-- DES1 passkey sign in (flag PASSKEY_DES1): one row per passkey a person added. Public material only: the credential id,
-- the COSE public key, the signature counter, transports and timestamps. No private key ever reaches the server. Additive only.
CREATE TABLE `passkeys_des1` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_des1_credential_uq` ON `passkeys_des1` (`credential_id`);
--> statement-breakpoint
CREATE INDEX `passkeys_des1_user_idx` ON `passkeys_des1` (`user_id`);
