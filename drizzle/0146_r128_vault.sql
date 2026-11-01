-- R128: team password vault. The server keeps only ciphertext: public keys, passphrase wrapped private keys, a hash of the
-- unlock proof, encrypted folder names and items, per member wrapped folder keys and audit rows (never a value). Additive only.
CREATE TABLE `vault_accounts` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`wrapped_private_key` text NOT NULL,
	`kdf_salt` text NOT NULL,
	`kdf_iterations` integer NOT NULL,
	`auth_hash` text NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`lockouts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`org_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `vault_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name_ct` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`needs_rotation` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vault_folders_org_idx` ON `vault_folders` (`org_id`);
--> statement-breakpoint
CREATE TABLE `vault_folder_keys` (
	`folder_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`org_id` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`access` text DEFAULT 'view' NOT NULL,
	`granted_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`folder_id`, `user_id`, `key_version`)
);
--> statement-breakpoint
CREATE INDEX `vault_folder_keys_user_idx` ON `vault_folder_keys` (`org_id`, `user_id`);
--> statement-breakpoint
CREATE TABLE `vault_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`ct` text NOT NULL,
	`key_version` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vault_items_folder_idx` ON `vault_items` (`folder_id`);
--> statement-breakpoint
CREATE TABLE `vault_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_name` text DEFAULT '' NOT NULL,
	`folder_id` text,
	`item_id` text,
	`action` text NOT NULL,
	`field` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vault_audit_org_at_idx` ON `vault_audit` (`org_id`, `at`);
