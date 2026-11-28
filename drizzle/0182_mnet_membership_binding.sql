ALTER TABLE mnet_devices ADD COLUMN membership_id text REFERENCES members(id) ON DELETE SET NULL;
