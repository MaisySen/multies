export type Folder = "inbox" | "sent" | "drafts" | "archive" | "spam" | "trash";
export const FOLDERS: Folder[] = ["inbox", "sent", "drafts", "archive", "spam", "trash"];

export interface Address { address: string; name?: string }

export interface AuthResults {
  spf?: "pass" | "fail" | "softfail" | "neutral" | "none";
  dkim?: "pass" | "fail" | "none";
  dmarc?: "pass" | "fail" | "none";
}
