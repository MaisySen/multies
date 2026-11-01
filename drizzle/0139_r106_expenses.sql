-- R106: expenses and receipts. Receipts come in by upload, phone camera or a forward to the workspace receipts address;
-- fields are read by the existing free text engine and rules, people check them, submit, an approver approves, and an
-- expense can be re billed onto an invoice draft. Money is integer cents. Additive only.
CREATE TABLE `expense_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`receipts_token` text,
	`approver_ids` text DEFAULT '[]' NOT NULL,
	`require_approval` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_settings_token_uq` ON `expense_settings` (`receipts_token`) WHERE `receipts_token` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`user_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`supplier` text,
	`supplier_abn` text,
	`spent_on` text,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`gst_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'AUD' NOT NULL,
	`category` text,
	`gst_claimable` integer DEFAULT 0 NOT NULL,
	`reimbursable` integer DEFAULT 1 NOT NULL,
	`note` text,
	`source` text DEFAULT 'upload' NOT NULL,
	`file_key` text,
	`file_parts` integer DEFAULT 0 NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`file_name` text,
	`file_type` text,
	`read_state` text DEFAULT 'none' NOT NULL,
	`read_token` text,
	`read_fields` text DEFAULT '[]' NOT NULL,
	`edited_fields` text DEFAULT '[]' NOT NULL,
	`splits` text DEFAULT '[]' NOT NULL,
	`every` text,
	`rebill_doc_id` text,
	`rebill_at` integer,
	`decided_by` text,
	`decided_by_name` text,
	`decided_at` integer,
	`reject_reason` text,
	`submitted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `expenses_org_user_idx` ON `expenses` (`org_id`,`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `expenses_org_status_idx` ON `expenses` (`org_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `expenses_org_supplier_idx` ON `expenses` (`org_id`,`supplier`);
