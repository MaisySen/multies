-- Local historical bookkeeping only. Preserve existing reserve/event evidence.
CREATE TABLE mnet_enrollment_handoffs_next (
 id text PRIMARY KEY NOT NULL, attempt_hash text NOT NULL,
 version integer NOT NULL CHECK(version=1), purpose text NOT NULL CHECK(purpose='mnet-enrollment'),
 user_id text, session_id text, workspace_id text,
 attempt_id text, device_public_key text, credential_digest text,
 issuer text, registrar_origin text, audience text, network_id text, mapping_revision text,
 challenge text, state text, platform text, redirect_uri text,
 status text NOT NULL CHECK(status IN ('pending','approved','declined','issued','expired','withdrawn','reserved','uncertain','consumed')),
 code_hash text, ticket_hash text,
 created_at integer NOT NULL, expires_at integer NOT NULL, code_expires_at integer, ticket_expires_at integer,
 terminal_at integer, scrubbed_at integer,
 service_id text, reserve_id text, descriptor_digest text, reserve_deadline integer,
 event_seq integer NOT NULL DEFAULT 0 CHECK(event_seq>=0 AND event_seq<=8),
 receipt_id text, receipt_digest text, descriptor_encoding_version integer,
 events text NOT NULL DEFAULT '[]' CHECK(json_valid(events) AND json_type(events)='array' AND json_array_length(events)<=8 AND json_array_length(events)=event_seq)
);


--> statement-breakpoint
INSERT INTO mnet_enrollment_handoffs_next (id,attempt_hash,version,purpose,user_id,session_id,workspace_id,attempt_id,device_public_key,credential_digest,issuer,registrar_origin,audience,network_id,mapping_revision,challenge,state,platform,redirect_uri,status,code_hash,ticket_hash,created_at,expires_at,code_expires_at,ticket_expires_at,terminal_at,scrubbed_at,service_id,reserve_id,descriptor_digest,reserve_deadline,events,event_seq,descriptor_encoding_version) SELECT id,attempt_hash,version,purpose,user_id,session_id,workspace_id,attempt_id,device_public_key,credential_digest,issuer,registrar_origin,audience,network_id,mapping_revision,challenge,state,platform,redirect_uri,status,code_hash,ticket_hash,created_at,expires_at,code_expires_at,ticket_expires_at,terminal_at,scrubbed_at,service_id,reserve_id,descriptor_digest,reserve_deadline,events,json_array_length(events),CASE WHEN status='reserved' THEN 1 ELSE NULL END FROM mnet_enrollment_handoffs WHERE (status='reserved' AND json_array_length(events)=1 AND json_extract(events,'$[0].seq')=1 AND json_extract(events,'$[0].kind')='reserve') OR (status!='reserved' AND json_array_length(events)=0);
--> statement-breakpoint
CREATE TABLE mnet_fixture_rebuild_count_guard (ok integer CHECK(ok=1));
--> statement-breakpoint
INSERT INTO mnet_fixture_rebuild_count_guard SELECT CASE WHEN (SELECT COUNT(*) FROM mnet_enrollment_handoffs_next)=(SELECT COUNT(*) FROM mnet_enrollment_handoffs) THEN 1 ELSE 0 END;
--> statement-breakpoint
DROP TABLE mnet_fixture_rebuild_count_guard;
--> statement-breakpoint
DROP TABLE mnet_enrollment_handoffs;
--> statement-breakpoint
ALTER TABLE mnet_enrollment_handoffs_next RENAME TO mnet_enrollment_handoffs;
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

--> statement-breakpoint
CREATE UNIQUE INDEX mnet_handoff_reserve_uq ON mnet_enrollment_handoffs(reserve_id);
