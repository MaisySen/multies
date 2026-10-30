/**
 * Tools P2: every advanced Tools feature sits behind its own flag. The Worker var TOOLS_FEATURES
 * is a comma list of feature ids ("all" turns every one on). Staging runs "all"; production lists
 * only what has shipped. The workspace admin switch (R63) still turns all of Tools off.
 */
export const TOOL_FEATURES = [
  "editor",     // 4 page editor (thumbnails, reorder, delete, rotate)
  "forms",      // 7 fill PDF forms
  "compare",    // 8 compare two PDFs
  "ocr_langs",  // 9 more OCR languages
  "scan",       // 12 camera scan to clean PDF
  "protect",    // 19 password protect
  "stamps",     // 20 stamps, page numbers, headers, footers
  "convert_plus", // 21 convert anything
  "excel",      // 22 Excel tools
  "autoredact", // 18 auto redact sensitive data
  "batch",      // 5 run a tool on every attachment in a thread
  "ask",        // 6 ask a document
  "translate",  // 11 translate keeping layout
  "extract",    // 2 invoices and receipts to a spreadsheet
  "expenses",   // 24 expense report from receipts
  "contracts",  // 23 contract helper
  "index",      // 17 search inside every attachment
  "folders",    // 16 smart folders
  "share",      // 13 secure share links
  "esign",      // 1 e-sign
  "rules",      // 3 auto rules before sending
  "workflows",  // 25 workflows
  "templates",  // 14 templates
  "merge_mail", // 15 bulk mail merge
  "api",        // 26 developer API for Tools
] as const;

export type ToolFeature = (typeof TOOL_FEATURES)[number];

export const isToolFeature = (v: string): v is ToolFeature => (TOOL_FEATURES as readonly string[]).includes(v);

/** Parses TOOLS_FEATURES. Unknown ids are ignored; "all" (or "*") is every feature. */
export function parseToolFeatures(raw: string | undefined | null): ToolFeature[] {
  const parts = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.includes("all") || parts.includes("*")) return [...TOOL_FEATURES];
  return TOOL_FEATURES.filter((f) => parts.includes(f));
}
