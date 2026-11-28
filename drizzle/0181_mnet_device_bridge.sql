CREATE TABLE mnet_devices (
 id text PRIMARY KEY NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 device_key text NOT NULL, challenge text NOT NULL, state text NOT NULL, platform text NOT NULL, redirect_uri text NOT NULL,
 status text NOT NULL, code_hash text, credential_hash text, expires_at integer NOT NULL, credential_expires_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_code_uq ON mnet_devices(code_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_credential_uq ON mnet_devices(credential_hash);
--> statement-breakpoint
CREATE INDEX mnet_owner_idx ON mnet_devices(user_id,workspace_id);
