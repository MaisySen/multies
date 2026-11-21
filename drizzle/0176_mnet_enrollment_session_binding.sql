-- Opaque independent per-handoff session pseudonym. Existing rows stay NULL and
-- cannot produce version2 provenance. No session ID/token hashing or backfill.
ALTER TABLE mnet_enrollment_handoffs ADD COLUMN session_binding text;
--> statement-breakpoint
ALTER TABLE mnet_enrollment_handoffs ADD COLUMN principal_authority text;
--> statement-breakpoint
ALTER TABLE mnet_enrollment_handoffs ADD COLUMN principal_namespace text;
--> statement-breakpoint
CREATE UNIQUE INDEX mnet_handoff_session_binding_uq ON mnet_enrollment_handoffs(session_binding);
