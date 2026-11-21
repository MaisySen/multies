-- New enrollment-only local journal. No FK cascades and no preview/List conversion.
CREATE TABLE mnet_enrollment_handoffs (
 id text PRIMARY KEY NOT NULL, attempt_hash text NOT NULL,
 version integer NOT NULL CHECK(version=1), purpose text NOT NULL CHECK(purpose='mnet-enrollment'),
 user_id text, session_id text, workspace_id text,
 attempt_id text, device_public_key text, credential_digest text,
 issuer text, registrar_origin text, audience text, network_id text, mapping_revision text,
 challenge text, state text, platform text, redirect_uri text,
 status text NOT NULL CHECK(status IN ('pending','approved','declined','issued','expired','withdrawn')),
 code_hash text, ticket_hash text,
 created_at integer NOT NULL, expires_at integer NOT NULL, code_expires_at integer, ticket_expires_at integer,
 terminal_at integer, scrubbed_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_handoff_attempt_uq ON mnet_enrollment_handoffs(attempt_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_handoff_code_uq ON mnet_enrollment_handoffs(code_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_handoff_ticket_uq ON mnet_enrollment_handoffs(ticket_hash);
--> statement-breakpoint
CREATE INDEX mnet_handoff_owner_idx ON mnet_enrollment_handoffs(user_id,status);
--> statement-breakpoint
CREATE INDEX mnet_handoff_retention_idx ON mnet_enrollment_handoffs(terminal_at,scrubbed_at);
