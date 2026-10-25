ALTER TABLE `tasks` ADD `import_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_org_import_key_uq` ON `tasks` (`org_id`,`import_key`) WHERE `import_key` IS NOT NULL;