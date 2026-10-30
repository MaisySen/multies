/**
 * Tools P2 (16): smart folders for mail attachments. Shared by the server (classifier, Files API) and the
 * web Files view. "other" holds everything the rules do not recognise.
 */
export const ATTACHMENT_FOLDERS = ["invoice", "receipt", "quote", "contract", "statement", "id", "payslip", "tax", "other"] as const;
export type AttachmentFolder = (typeof ATTACHMENT_FOLDERS)[number];

export const ATTACHMENT_FOLDER_LABELS: Record<AttachmentFolder, string> = {
  invoice: "Invoices", receipt: "Receipts", quote: "Quotes", contract: "Contracts", statement: "Statements",
  id: "ID documents", payslip: "Payslips", tax: "Tax", other: "Other",
};

export const isAttachmentFolder = (v: unknown): v is AttachmentFolder => typeof v === "string" && (ATTACHMENT_FOLDERS as readonly string[]).includes(v);

/** The Files API answers for one folder row. */
export interface FileFolderCount { id: AttachmentFolder; label: string; count: number }
export interface FileItem {
  attachmentId: string; filename: string; sizeBytes: number; folder: AttachmentFolder; manual: boolean;
  messageId: string; threadId: string; mailboxId: string; subject: string; from: string; date: string; url: string; snippet?: string;
}
export interface FileFolders { folders: FileFolderCount[]; indexing: { on: boolean; indexed: number; waiting: number } }

/** OCR languages the indexer offers (the engine's extract-text language option). English unless more OCR languages are on. */
export const INDEX_OCR_LANGS = [
  { id: "eng", label: "English" },
  { id: "eng+nep", label: "English and Nepali" },
  { id: "eng+hin", label: "English and Hindi" },
] as const;
