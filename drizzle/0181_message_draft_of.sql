-- Wave 2 review X11: on a draft, the id of the first copy of this draft (each save stores a new copy and deletes the
-- old one), so a save that lost a race finds the copy that won it, not another draft in the same thread. Null on every
-- existing row; old code never reads or writes it. Adding a nullable column is a metadata change in SQLite.
ALTER TABLE `messages` ADD `draft_of` text;
