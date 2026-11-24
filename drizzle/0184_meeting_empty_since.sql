-- Wave 3 review Y4: when the meeting's room first read empty after people were in it. Each Worker isolate kept its own
-- first empty read, so an isolate holding an old one ended a live meeting on one momentary empty read. Kept here, any
-- read that sees people clears it, so the grace always runs from a real empty start. Null on existing rows.
ALTER TABLE `meetings` ADD `empty_since` integer;
