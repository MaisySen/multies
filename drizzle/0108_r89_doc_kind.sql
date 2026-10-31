-- R89: docs visual. Additive only.
-- docs.kind: "whiteboard" for a doc that is one board, so the list and the page tree show its icon and the page opens the
-- canvas. Written by the server from the content on every create and update; every existing doc stays "doc".
ALTER TABLE `docs` ADD `kind` text DEFAULT 'doc' NOT NULL;
