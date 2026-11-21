CREATE TABLE mnet_enrollment_decisions (
 id text PRIMARY KEY NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 attempt_id text NOT NULL, device_public_key text NOT NULL,
 issuer text NOT NULL, registrar_origin text NOT NULL, audience text NOT NULL,
 network_id text NOT NULL, mapping_revision text NOT NULL,
 status text NOT NULL, expires_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_enrollment_attempt_uq ON mnet_enrollment_decisions(attempt_id);
--> statement-breakpoint
CREATE INDEX mnet_enrollment_owner_idx ON mnet_enrollment_decisions(user_id,expires_at);
