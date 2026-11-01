-- R105: invoices and quotes (tax invoices, quotes, adjustment notes, bills), an items catalogue, manual payments,
-- repeating invoices and suppliers. Money is integer cents; quantities are thousandths. Numbers are given only when a
-- document is issued and are unique per workspace and kind (voided documents keep theirs). Additive only.
CREATE TABLE `invoice_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`business_name` text DEFAULT '' NOT NULL,
	`abn` text,
	`gst_registered` integer DEFAULT 1 NOT NULL,
	`price_mode` text DEFAULT 'exclusive' NOT NULL,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`terms_days` integer DEFAULT 14 NOT NULL,
	`address` text,
	`email` text,
	`phone` text,
	`bank_name` text,
	`bsb` text,
	`account_number` text,
	`account_name` text,
	`pay_note` text,
	`footer` text,
	`prefix_invoice` text,
	`prefix_quote` text,
	`prefix_credit` text,
	`next_invoice` integer DEFAULT 1 NOT NULL,
	`next_quote` integer DEFAULT 1 NOT NULL,
	`next_credit_note` integer DEFAULT 1 NOT NULL,
	`next_bill` integer DEFAULT 1 NOT NULL,
	`remind_before_days` integer DEFAULT 3 NOT NULL,
	`remind_after_days` integer DEFAULT 7 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`unit_cents` integer DEFAULT 0 NOT NULL,
	`gst_free` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoice_items_org_idx` ON `invoice_items` (`org_id`,`name`);
--> statement-breakpoint
CREATE TABLE `invoice_suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`abn` text,
	`email` text,
	`phone` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoice_suppliers_org_idx` ON `invoice_suppliers` (`org_id`,`name`);
--> statement-breakpoint
CREATE TABLE `invoice_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`seq` integer,
	`number` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`contact_id` text,
	`supplier_id` text,
	`deal_id` text,
	`buyer_name` text,
	`buyer_email` text,
	`buyer_abn` text,
	`buyer_address` text,
	`issue_date` text,
	`due_date` text,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`price_mode` text DEFAULT 'exclusive' NOT NULL,
	`gst_registered` integer DEFAULT 1 NOT NULL,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`gst_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`paid_cents` integer DEFAULT 0 NOT NULL,
	`credited_cents` integer DEFAULT 0 NOT NULL,
	`reference` text,
	`notes` text,
	`terms` text,
	`source_id` text,
	`converted_id` text,
	`repeat_id` text,
	`view_token` text,
	`sent_at` integer,
	`viewed_at` integer,
	`answered_at` integer,
	`last_reminder_at` integer,
	`reminder_count` integer DEFAULT 0 NOT NULL,
	`voided_at` integer,
	`void_reason` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_docs_number_uq` ON `invoice_docs` (`org_id`,`kind`,`seq`) WHERE `seq` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_docs_token_uq` ON `invoice_docs` (`view_token`) WHERE `view_token` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `invoice_docs_org_kind_idx` ON `invoice_docs` (`org_id`,`kind`,`created_at`);
--> statement-breakpoint
CREATE INDEX `invoice_docs_contact_idx` ON `invoice_docs` (`org_id`,`contact_id`) WHERE `contact_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `invoice_docs_due_idx` ON `invoice_docs` (`kind`,`status`,`due_date`);
--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_id` text NOT NULL,
	`org_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`item_id` text,
	`description` text DEFAULT '' NOT NULL,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`unit_cents` integer DEFAULT 0 NOT NULL,
	`gst_free` integer DEFAULT 0 NOT NULL,
	`net_cents` integer DEFAULT 0 NOT NULL,
	`gst_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_doc_idx` ON `invoice_lines` (`doc_id`,`position`);
--> statement-breakpoint
CREATE TABLE `invoice_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`paid_on` text NOT NULL,
	`method` text DEFAULT 'bank' NOT NULL,
	`reference` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoice_payments_doc_idx` ON `invoice_payments` (`doc_id`);
--> statement-breakpoint
CREATE INDEX `invoice_payments_org_idx` ON `invoice_payments` (`org_id`,`paid_on`);
--> statement-breakpoint
CREATE TABLE `invoice_repeats` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`source_id` text NOT NULL,
	`every` text NOT NULL,
	`anchor_day` integer NOT NULL,
	`next_run` text NOT NULL,
	`end_date` text,
	`auto_send` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`last_doc_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoice_repeats_due_idx` ON `invoice_repeats` (`active`,`next_run`);
--> statement-breakpoint
CREATE INDEX `invoice_repeats_org_idx` ON `invoice_repeats` (`org_id`);
