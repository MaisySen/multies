-- Tools P1: a workspace switch for Tools. NULL follows the default (on wherever the deployment has Tools),
-- "off" hides Tools for the workspace, "on" keeps them on. Read only by the Tools routes.
ALTER TABLE `organizations` ADD `tools_mode` text;
