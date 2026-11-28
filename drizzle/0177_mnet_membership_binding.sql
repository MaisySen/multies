ALTER TABLE mnet_devices ADD COLUMN membership_id text REFERENCES members(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE mnet_enrollment_decisions ADD COLUMN membership_id text REFERENCES members(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE mnet_enrollment_handoffs ADD COLUMN membership_id text REFERENCES members(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX mnet_device_membership_idx ON mnet_devices(membership_id);
--> statement-breakpoint
CREATE INDEX mnet_enrollment_membership_idx ON mnet_enrollment_decisions(membership_id);
--> statement-breakpoint
CREATE INDEX mnet_handoff_membership_idx ON mnet_enrollment_handoffs(membership_id);
