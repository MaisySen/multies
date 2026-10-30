-- R31: a form's routing rules: after a submission, the first rule whose condition matches picks the task's project and assignee.
-- JSON: [{ when: { field, op, value }, projectId, assigneeId }]. One column, no backfill: every existing form reads '[]'.
ALTER TABLE `forms` ADD `routing` text DEFAULT '[]' NOT NULL;
