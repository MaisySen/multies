-- Round 2: an API key may end on a date picked when it is made (Settings, Developers). Null, the default and every
-- existing key, means it never ends, so older code that doesn't read the column behaves exactly as before.
ALTER TABLE `api_keys` ADD `expires_at` integer;
