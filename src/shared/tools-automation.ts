/**
 * Tools P2 (automation): what the web app and the server share for auto rules before sending,
 * workflows, document templates and mail merge. Pure functions only (no I/O), so both sides and the
 * tests use the same rules.
 */
import type { PlanId } from "./plans";

const MB = 1024 * 1024;

// ------------------------------------------------------------------ 3: auto rules before sending

export type RuleMode = "on" | "off";
export interface SendRules { compress: boolean; compressOverMb: number; wordPdf: boolean }
/** A stored rules row: NULL columns follow the workspace (for a person) or the default (for the workspace). */
export interface SendRulesRow { compress: RuleMode | null; compressOverMb: number | null; wordPdf: RuleMode | null }

export const DEFAULT_SEND_RULES: SendRules = { compress: false, compressOverMb: 5, wordPdf: false };
export const RULE_MB_MIN = 1;
export const RULE_MB_MAX = 50;

/** The rules that apply to one person: their own row over the workspace row over the defaults. */
export function effectiveRules(workspace: SendRulesRow | null, mine: SendRulesRow | null): SendRules {
  const pick = <K extends keyof SendRulesRow>(k: K) => mine?.[k] ?? workspace?.[k] ?? null;
  const c = pick("compress");
  const w = pick("wordPdf");
  const mb = pick("compressOverMb");
  return {
    compress: c === null ? DEFAULT_SEND_RULES.compress : c === "on",
    compressOverMb: typeof mb === "number" ? clampMb(mb) : DEFAULT_SEND_RULES.compressOverMb,
    wordPdf: w === null ? DEFAULT_SEND_RULES.wordPdf : w === "on",
  };
}

export const clampMb = (n: number) => Math.min(RULE_MB_MAX, Math.max(RULE_MB_MIN, Math.round(n)));

const WORD_EXT = /\.(docx?|odt|rtf)$/i;
const WORD_TYPES = new Set(["application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.oasis.opendocument.text", "application/rtf", "text/rtf"]);
export const isWordFile = (name: string, type = "") => WORD_EXT.test(name) || WORD_TYPES.has(type.toLowerCase());
export const isPdfFile = (name: string, type = "") => /\.pdf$/i.test(name) || type.toLowerCase() === "application/pdf";

/** Which Tools op a rule runs on this attachment, or null when no rule matches. */
export function ruleFor(rules: SendRules, file: { name: string; type?: string; size: number }): "compress" | "convert" | null {
  if (rules.wordPdf && isWordFile(file.name, file.type)) return "convert";
  if (rules.compress && isPdfFile(file.name, file.type) && file.size > rules.compressOverMb * MB) return "compress";
  return null;
}

/** The composer's attachments in one email (decoded), and how many files. */
export const COMPOSE_ATTACH_MAX_BYTES = 20 * MB;
export const COMPOSE_ATTACH_MAX_FILES = 10;

export const formatMb = (bytes: number) => `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;

// ------------------------------------------------------------------ 25: workflows

/** Ops a workflow step may use (the engine's chain op takes any op except chain itself). */
export const WORKFLOW_OPS = [
  "scan-clean", "ocr", "compress", "rotate", "scrub", "watermark", "stamp", "protect", "unlock", "convert", "to-pdf",
  "merge", "images-to-pdf", "redact", "pdf-to-docx", "pdf-to", "split", "to-jpeg",
] as const;
export type WorkflowOp = (typeof WORKFLOW_OPS)[number];
export const isWorkflowOp = (v: string): v is WorkflowOp => (WORKFLOW_OPS as readonly string[]).includes(v);

/** Short labels for the builder (the Tools catalogue has the long ones). */
export const WORKFLOW_OP_LABELS: Record<WorkflowOp, string> = {
  "scan-clean": "Clean up a scan", ocr: "Make text searchable (OCR)", compress: "Compress", rotate: "Rotate", scrub: "Remove hidden data",
  watermark: "Watermark", stamp: "Stamp or page numbers", protect: "Add a password", unlock: "Remove a password", convert: "Office file to PDF",
  "to-pdf": "Anything to PDF", merge: "Merge into one PDF", "images-to-pdf": "Images to PDF", redact: "Black out words",
  "pdf-to-docx": "PDF to Word", "pdf-to": "PDF to text or images", split: "Split", "to-jpeg": "PDF to images",
};

/** Ops whose output is no longer a PDF, so only one of them may come last. */
const ENDS_CHAIN = new Set<WorkflowOp>(["pdf-to-docx", "pdf-to", "split", "to-jpeg"]);
/** Ops that take more than one input file (only as the first step). */
const MANY_IN = new Set<WorkflowOp>(["merge", "images-to-pdf", "scan-clean"]);
/** Options that must never be stored in a saved workflow (asked for at run time instead). */
export const SECRET_OPTIONS = new Set(["password"]);

export type WorkflowFinish = "download" | "email" | "share";
export interface WorkflowStep { op: WorkflowOp; options: Record<string, string> }
export interface WorkflowDef { name: string; steps: WorkflowStep[]; finish: WorkflowFinish }

export const WORKFLOW_MIN_STEPS = 2;
export const WORKFLOW_MAX_STEPS = 6;

/** A plain reason the steps can't run as a chain, or null when they can. */
export function checkWorkflow(steps: WorkflowStep[]): string | null {
  if (steps.length < WORKFLOW_MIN_STEPS || steps.length > WORKFLOW_MAX_STEPS) return `A workflow has ${WORKFLOW_MIN_STEPS} to ${WORKFLOW_MAX_STEPS} steps.`;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!isWorkflowOp(s.op)) return `Step ${i + 1} uses a tool workflows can't run.`;
    if (i > 0 && MANY_IN.has(s.op)) return `${WORKFLOW_OP_LABELS[s.op]} can only be the first step.`;
    if (i < steps.length - 1 && ENDS_CHAIN.has(s.op)) return `${WORKFLOW_OP_LABELS[s.op]} can only be the last step.`;
    for (const k of Object.keys(s.options ?? {})) if (SECRET_OPTIONS.has(k)) return "Passwords are asked for each time a workflow runs, so they aren't saved.";
  }
  return null;
}

/** The built in starters (shown to every workspace; saving one makes an editable copy). */
export const WORKFLOW_STARTERS: (WorkflowDef & { id: string; blurb: string })[] = [
  { id: "starter-scan-searchable", name: "Scan to searchable PDF", blurb: "Clean up photos of pages, make the text searchable, then shrink the file.", finish: "email",
    steps: [{ op: "scan-clean", options: { mode: "gray", ocr: "no" } }, { op: "ocr", options: { language: "eng" } }, { op: "compress", options: {} }] },
  { id: "starter-shrink-protect", name: "Shrink and protect", blurb: "Compress a PDF, then lock it with a password you type each time.", finish: "email",
    steps: [{ op: "compress", options: {} }, { op: "protect", options: { allow_print: "yes", allow_copy: "no" } }] },
  { id: "starter-word-watermark", name: "Word to PDF and watermark", blurb: "Turn a Word file into a PDF and mark every page.", finish: "download",
    steps: [{ op: "convert", options: {} }, { op: "watermark", options: { text: "DRAFT" } }] },
];

/** Steps that need a password typed at run time. */
export const needsRunPassword = (steps: WorkflowStep[]) => steps.some((s) => s.op === "protect" || s.op === "unlock");

// ------------------------------------------------------------------ 14: templates

export type TemplateFieldType = "text" | "textarea" | "date" | "number" | "email" | "money" | "lines";
export const TEMPLATE_FIELD_TYPES: TemplateFieldType[] = ["text", "textarea", "date", "number", "email", "money", "lines"];
export interface TemplateField { key: string; label: string; type: TemplateFieldType; required?: boolean }
export type TemplateKind = "invoice" | "quote" | "letter" | "custom";
export interface TemplateDef { id: string; kind: TemplateKind; name: string; html: string; fields: TemplateField[]; builtIn?: boolean }
export interface LineItem { description: string; quantity: number; unitPrice: number }

export const TEMPLATE_HTML_MAX = 100_000;
export const TEMPLATE_FIELDS_MAX = 40;
export const LINES_MAX = 50;
export const GST_RATE = 0.1;
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => `$${round2(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Line totals, GST at 10 percent and the total. Prices are before GST unless gstIncluded. */
export function invoiceTotals(lines: LineItem[], opts: { gst?: boolean; gstIncluded?: boolean } = {}) {
  const rows = lines.map((l) => ({ ...l, total: round2((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0)) }));
  const sum = round2(rows.reduce((a, r) => a + r.total, 0));
  if (opts.gst === false) return { rows, subtotal: sum, gst: 0, total: sum };
  if (opts.gstIncluded) { const gst = round2(sum / 11); return { rows, subtotal: round2(sum - gst), gst, total: sum }; }
  const gst = round2(sum * GST_RATE);
  return { rows, subtotal: sum, gst, total: round2(sum + gst) };
}

/** Parses the lines value the form sends (JSON or an array). Bad rows are dropped. */
export function parseLines(v: unknown): LineItem[] {
  let arr: unknown = v;
  if (typeof v === "string") { try { arr = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, LINES_MAX).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { description: String(o.description ?? "").slice(0, 300), quantity: Number(o.quantity ?? 1) || 0, unitPrice: Number(o.unitPrice ?? o.unit_price ?? 0) || 0 };
  }).filter((l) => l.description.trim() || l.unitPrice);
}

const SECTION = /\{\{#lines\}\}([\s\S]*?)\{\{\/lines\}\}/g;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;

/** Values every template can use besides its own fields. */
export interface TemplateContext { workspaceName: string; logoDataUri?: string | null; today: string }

/**
 * Fills a template: {{#lines}}...{{/lines}} repeats per line item ({{description}}, {{quantity}},
 * {{unit_price}}, {{line_total}}), {{subtotal}} {{gst}} {{total}} are computed, textarea values keep
 * their line breaks, {{?key}}...{{/key}} shows only when the field has a value, {{logo}} is an img tag when a logo exists, and every value is escaped.
 */
export function fillTemplate(t: Pick<TemplateDef, "html" | "fields">, values: Record<string, unknown>, ctx: TemplateContext): string {
  const linesField = t.fields.find((f) => f.type === "lines");
  const lines = linesField ? parseLines(values[linesField.key]) : [];
  const gstOff = String(values.gst ?? "").toLowerCase() === "no";
  const totals = invoiceTotals(lines, { gst: !gstOff, gstIncluded: String(values.gst ?? "").toLowerCase() === "included" });
  let html = t.html.replace(SECTION, (_m, row: string) => totals.rows.map((r) => row.replace(PLACEHOLDER, (m2, k: string) => {
    if (k === "description") return escapeHtml(r.description);
    if (k === "quantity") return escapeHtml(String(r.quantity));
    if (k === "unit_price") return escapeHtml(money(r.unitPrice));
    if (k === "line_total") return escapeHtml(money(r.total));
    return m2;
  })).join(""));
  // {{?key}}...{{/key}} keeps its contents only when the field has a value (an empty ABN or due date prints no label).
  html = html.replace(/\{\{\?([a-z][a-z0-9_]{0,39})\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k: string, inner: string) => (String(values[k] ?? "").trim() ? inner : ""));
  const types = new Map(t.fields.map((f) => [f.key, f.type]));
  html = html.replace(PLACEHOLDER, (_m, k: string) => {
    if (k === "logo") return ctx.logoDataUri ? `<img class="logo" src="${escapeHtml(ctx.logoDataUri)}" alt="">` : "";
    if (k === "workspace_name") return escapeHtml(ctx.workspaceName);
    if (k === "today") return escapeHtml(ctx.today);
    if (k === "subtotal") return escapeHtml(money(totals.subtotal));
    if (k === "gst") return escapeHtml(money(totals.gst));
    if (k === "total") return escapeHtml(money(totals.total));
    const raw = values[k];
    const v = raw === undefined || raw === null ? "" : String(raw);
    const type = types.get(k);
    if (type === "money" && v !== "") return escapeHtml(money(Number(v) || 0));
    if (type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return escapeHtml(auDate(v));
    if (type === "textarea") return escapeHtml(v).replace(/\r?\n/g, "<br>");
    return escapeHtml(v);
  });
  return html;
}

/** "2026-10-30" to "30 October 2026". */
export function auDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** Placeholders a template uses (to check custom templates against their fields). */
export function placeholdersIn(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.replace(SECTION, "").matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}
export const BUILT_IN_KEYS = new Set(["logo", "workspace_name", "today", "subtotal", "gst", "total"]);

// The engine prints these with the office suite's HTML import, which lays out tables and plain CSS on text but not
// flex, grid or borders on blocks (on staging every line of the old flex layout got its own blue rule). So the layout is
// tables with width and align attributes, and lines are table cell borders.
const BASE_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1f2430; font-size: 10.5pt; line-height: 1.4; margin: 0; }
  p, div { margin: 0; padding: 0; }
  td, th { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt; vertical-align: top; }
  .logo { max-height: 56px; max-width: 180px; }
  .biz { font-size: 15pt; font-weight: bold; }
  .muted { color: #667085; }
  .title { font-size: 22pt; font-weight: bold; color: #2f5bea; letter-spacing: 1pt; }
  .rule td { border-bottom: 2.5pt solid #2f5bea; font-size: 4pt; line-height: 4pt; }
  .label { font-size: 8pt; color: #667085; letter-spacing: 1pt; }
  .items th { font-size: 8pt; color: #667085; letter-spacing: 0.5pt; border-bottom: 1pt solid #d0d5dd; font-weight: normal; }
  .items td { border-bottom: 0.5pt solid #eaecf0; }
  .grand td { border-top: 1.5pt solid #1f2430; font-weight: bold; font-size: 12.5pt; }
  .notes td { background: #f5f7fb; }
  .letter p { margin: 0 0 12px; }
`;

const docHead = (title: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${BASE_CSS}</style></head><body>`;

const RULE = `<hr color="#2f5bea" size="3" noshade>`;
const GAP = `<p>&nbsp;</p>`;

const ITEMS = `<table width="100%" cellpadding="6" cellspacing="0" class="items"><thead><tr><th align="left" width="52%">DESCRIPTION</th><th align="right" width="10%">QTY</th><th align="right" width="19%">UNIT PRICE</th><th align="right" width="19%">AMOUNT</th></tr></thead><tbody>{{#lines}}<tr><td align="left" valign="top">{{description}}</td><td align="right" valign="top">{{quantity}}</td><td align="right" valign="top">{{unit_price}}</td><td align="right" valign="top">{{line_total}}</td></tr>{{/lines}}
<tr><td colspan="2">&nbsp;</td><td align="right" class="muted">Subtotal</td><td align="right">{{subtotal}}</td></tr>
<tr><td colspan="2">&nbsp;</td><td align="right" class="muted">GST (10%)</td><td align="right">{{gst}}</td></tr>
<tr class="grand"><td colspan="2">&nbsp;</td><td align="right"><strong>Total</strong></td><td align="right"><strong>{{total}}</strong></td></tr></tbody></table>`;

const SELLER = `<td width="55%" valign="top">{{logo}}<p><span class="biz">{{business_name}}</span>{{?business_abn}}<br><span class="muted">ABN {{business_abn}}</span>{{/business_abn}}{{?business_address}}<br><span class="muted">{{business_address}}</span>{{/business_address}}</p></td>`;

const NOTES = `{{?notes}}${GAP}<table width="100%" cellpadding="10" cellspacing="0" class="notes"><tr><td bgcolor="#f5f7fb">{{notes}}</td></tr></table>{{/notes}}`;

const INVOICE_HTML = `${docHead("Tax invoice")}
<table width="100%" cellpadding="0" cellspacing="0"><tr>${SELLER}<td width="45%" align="right" valign="top"><p align="right"><span class="title">TAX INVOICE</span><br>Invoice {{invoice_number}}<br><span class="muted">Issued {{issue_date}}</span>{{?due_date}}<br><span class="muted">Due {{due_date}}</span>{{/due_date}}</p></td></tr></table>
${RULE}
<table width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" valign="top"><p><span class="label">BILL TO</span><br><strong>{{client_name}}</strong>{{?client_email}}<br>{{client_email}}{{/client_email}}{{?client_address}}<br>{{client_address}}{{/client_address}}</p></td><td width="50%" valign="top">{{?payment_details}}<p><span class="label">PAYMENT DETAILS</span><br>{{payment_details}}</p>{{/payment_details}}</td></tr></table>
${GAP}${ITEMS}
${NOTES}
</body></html>`;

const QUOTE_HTML = `${docHead("Quote")}
<table width="100%" cellpadding="0" cellspacing="0"><tr>${SELLER}<td width="45%" align="right" valign="top"><p align="right"><span class="title">QUOTE</span><br>Quote {{quote_number}}<br><span class="muted">Date {{issue_date}}</span><br><span class="muted">Valid until {{valid_until}}</span></p></td></tr></table>
${RULE}
<p><span class="label">PREPARED FOR</span><br><strong>{{client_name}}</strong>{{?client_email}}<br>{{client_email}}{{/client_email}}{{?client_address}}<br>{{client_address}}{{/client_address}}</p>
${GAP}${ITEMS}
${NOTES}
</body></html>`;

const LETTER_HTML = `${docHead("Letter")}
<table width="100%" cellpadding="0" cellspacing="0"><tr><td width="60%" valign="top">{{logo}}<p><span class="biz">{{sender_name}}</span><br><span class="muted">{{sender_address}}</span></p></td><td width="40%" align="right" valign="top"><p align="right" class="muted">{{letter_date}}</p></td></tr></table>
${RULE}
<div class="letter"><p>{{recipient_name}}<br>{{recipient_address}}</p><p><strong>{{subject}}</strong></p><p>Dear {{recipient_name}},</p><p>{{body}}</p><p>{{sign_off}}</p><p><strong>{{signer_name}}</strong></p></div>
</body></html>`;

const SELLER_FIELDS: TemplateField[] = [
  { key: "business_name", label: "Your business name", type: "text", required: true },
  { key: "business_abn", label: "Your ABN", type: "text" },
  { key: "business_address", label: "Your address", type: "textarea" },
];
const CLIENT_FIELDS: TemplateField[] = [
  { key: "client_name", label: "Client name", type: "text", required: true },
  { key: "client_email", label: "Client email", type: "email" },
  { key: "client_address", label: "Client address", type: "textarea" },
];

export const BUILT_IN_TEMPLATES: TemplateDef[] = [
  { id: "builtin-invoice", kind: "invoice", name: "Invoice", builtIn: true, html: INVOICE_HTML, fields: [
    ...SELLER_FIELDS, ...CLIENT_FIELDS,
    { key: "invoice_number", label: "Invoice number", type: "text", required: true },
    { key: "issue_date", label: "Issue date", type: "date", required: true },
    { key: "due_date", label: "Due date", type: "date" },
    { key: "lines", label: "Items", type: "lines", required: true },
    { key: "payment_details", label: "Payment details (BSB, account, PayID)", type: "textarea" },
    { key: "notes", label: "Notes", type: "textarea" },
  ] },
  { id: "builtin-quote", kind: "quote", name: "Quote", builtIn: true, html: QUOTE_HTML, fields: [
    ...SELLER_FIELDS, ...CLIENT_FIELDS,
    { key: "quote_number", label: "Quote number", type: "text", required: true },
    { key: "issue_date", label: "Date", type: "date", required: true },
    { key: "valid_until", label: "Valid until", type: "date" },
    { key: "lines", label: "Items", type: "lines", required: true },
    { key: "notes", label: "Notes", type: "textarea" },
  ] },
  { id: "builtin-letter", kind: "letter", name: "Letter", builtIn: true, html: LETTER_HTML, fields: [
    { key: "sender_name", label: "From", type: "text", required: true },
    { key: "sender_address", label: "Your address", type: "textarea" },
    { key: "letter_date", label: "Date", type: "date", required: true },
    { key: "recipient_name", label: "To", type: "text", required: true },
    { key: "recipient_address", label: "Their address", type: "textarea" },
    { key: "subject", label: "Subject", type: "text" },
    { key: "body", label: "Letter", type: "textarea", required: true },
    { key: "sign_off", label: "Sign off", type: "text" },
    { key: "signer_name", label: "Your name", type: "text" },
  ] },
];

export const builtInTemplate = (id: string) => BUILT_IN_TEMPLATES.find((t) => t.id === id) ?? null;

/** Default values a new form starts with (workspace name as the business, today's date). */
export function templateDefaults(t: TemplateDef, ctx: TemplateContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of t.fields) {
    if (f.key === "business_name" || f.key === "sender_name") out[f.key] = ctx.workspaceName;
    else if (f.type === "date" && /issue_date|letter_date/.test(f.key)) out[f.key] = ctx.today;
    else if (f.type === "lines") out[f.key] = JSON.stringify([{ description: "", quantity: 1, unitPrice: 0 }]);
    else if (f.key === "sign_off") out[f.key] = "Kind regards,";
  }
  return out;
}

/** Fields the form left empty that the template marks as required. */
export function missingRequired(t: Pick<TemplateDef, "fields">, values: Record<string, unknown>): string[] {
  return t.fields.filter((f) => f.required && (f.type === "lines" ? parseLines(values[f.key]).length === 0 : !String(values[f.key] ?? "").trim())).map((f) => f.label);
}

/**
 * For mail merge (one engine render per person from one template): the lines section becomes one
 * row whose values come from the person's columns, and totals are worked out per person.
 */
export function mergeTemplateHtml(html: string): string {
  // The engine fills merge rows itself and knows only plain placeholders, so {{?key}}...{{/key}} keeps its contents here.
  return html.replace(/\{\{\?([a-z][a-z0-9_]{0,39})\}\}([\s\S]*?)\{\{\/\1\}\}/g, "$2").replace(SECTION, (_m, row: string) => row
    .replace(/\{\{\s*description\s*\}\}/g, "{{item}}").replace(/\{\{\s*quantity\s*\}\}/g, "{{qty}}")
    .replace(/\{\{\s*unit_price\s*\}\}/g, "{{unit_price_text}}").replace(/\{\{\s*line_total\s*\}\}/g, "{{line_total}}"));
}

/** One person's values for a merge render: their columns plus the computed line, totals and dates. */
export function mergeRowValues(t: Pick<TemplateDef, "fields">, row: Record<string, string>, ctx: TemplateContext): Record<string, string> {
  const out: Record<string, string> = { workspace_name: ctx.workspaceName, today: ctx.today };
  const types = new Map(t.fields.map((f) => [f.key, f.type]));
  for (const [k, v] of Object.entries(row)) {
    const type = types.get(k);
    out[k] = type === "money" && v !== "" ? money(Number(v) || 0) : type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? auDate(v) : v;
  }
  if (t.fields.some((f) => f.type === "lines")) {
    const line = { description: row.item ?? "", quantity: Number(row.qty ?? 1) || 1, unitPrice: Number(String(row.unit_price ?? "0").replace(/[$,\s]/g, "")) || 0 };
    const tot = invoiceTotals([line], { gst: String(row.gst ?? "").toLowerCase() !== "no" });
    Object.assign(out, { item: line.description, qty: String(line.quantity), unit_price_text: money(line.unitPrice), line_total: money(tot.rows[0].total), subtotal: money(tot.subtotal), gst: money(tot.gst), total: money(tot.total) });
  }
  return out;
}

/** Fields a person can map columns to in a merge (the lines field becomes item, qty and unit price). */
export function mergeFields(t: Pick<TemplateDef, "fields">): TemplateField[] {
  const out: TemplateField[] = [];
  for (const f of t.fields) {
    if (f.type === "lines") out.push({ key: "item", label: "Item", type: "text" }, { key: "qty", label: "Quantity", type: "number" }, { key: "unit_price", label: "Unit price", type: "money" });
    else out.push(f);
  }
  return out;
}

// ------------------------------------------------------------------ 15: mail merge

/** People a workspace can mail merge to per UTC day (on top of the plan's normal sending limit). */
export const MERGE_DAILY_CAP: Record<PlanId, number> = { starter: 50, pro: 500, business: 2000 };
export const MERGE_MAX_ROWS = 500;
/** Seconds between two sends of one run, so a run is spread over time by the job queue. */
export const MERGE_SPACING_SECONDS = 6;

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

const TEXT_PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/g;
/** Fills {{name}}, {{first_name}}, {{email}} and the person's columns into plain text (no HTML). */
export function fillText(text: string, person: { name: string; email: string; data: Record<string, string> }): string {
  return text.replace(TEXT_PLACEHOLDER, (_m, k: string) => {
    if (k === "name") return person.name;
    if (k === "first_name") return firstName(person.name) || person.name;
    if (k === "email") return person.email;
    return person.data[k] ?? "";
  });
}

/** The greeting is always personal: a body with no name in it starts with "Hi <first name>,". */
export function personalBody(body: string, person: { name: string; email: string; data: Record<string, string> }): string {
  const named = /\{\{\s*(first_name|name)\s*\}\}/.test(body);
  const filled = fillText(body, person);
  if (named) return filled;
  const hi = firstName(person.name);
  return `${hi ? `Hi ${hi},` : "Hi,"}\n\n${filled}`;
}

export const unsubscribeLine = (workspace: string, url: string) =>
  `\n\n--\nYou're getting this email from ${workspace}. To stop getting these emails, unsubscribe here: ${url}`;

/** Splits a CSV text into rows of strings (quotes, commas inside quotes, CRLF). For small lists only. */
export function parseCsv(text: string, maxRows = MERGE_MAX_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);
