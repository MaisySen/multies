-- R102 (Nov 1): the text of documents read for Files > Documents. rowid = doc_inbox.id in the main database; item_id
-- and org_id are carried and every hit is checked against the main row and the drive access check before it is shown.
-- scope: the workspace token, so a search never walks another workspace's rows. Rebuildable (Read again), not backed up.
CREATE VIRTUAL TABLE IF NOT EXISTS `doc_fts` USING fts5(text, scope, item_id UNINDEXED, org_id UNINDEXED, detail='column', tokenize='unicode61 remove_diacritics 2');
