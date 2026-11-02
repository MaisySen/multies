-- AI2 (Nov 2): connect AI properly. A custom OpenAI compatible server's base address on the saved key, the live
-- model list cache (10 minutes, per workspace) and the one tap OpenRouter sign in state (PKCE verifier kept here,
-- encrypted, 10 minutes, one use). Additive only.
ALTER TABLE `ai_keys` ADD COLUMN `base_url` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_model_cache` (
	`org_id` text PRIMARY KEY NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`fingerprint` text NOT NULL,
	`models_json` text NOT NULL,
	`live` integer DEFAULT 1 NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ai_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL REFERENCES `organizations`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`nonce_hash` text NOT NULL,
	`verifier_enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ai_oauth_states_created_idx` ON `ai_oauth_states` (`created_at`);
