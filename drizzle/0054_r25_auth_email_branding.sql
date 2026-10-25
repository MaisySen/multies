-- R25 (MB-60): per hook branding for auth emails (logo, colour, reply-to, footer, per type text, second language) as JSON. NULL keeps the round 13 email. No index.
ALTER TABLE `auth_email_hooks` ADD `branding` text;
