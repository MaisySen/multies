/**
 * R94: contacts from a CSV file. Parsed in the browser (the file never needs to reach the server whole), mapped by
 * header, checked and deduplicated by email before anything is sent. Own code, RFC 4180 rules.
 */

export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

/** Splits CSV text into rows of cells: quoted cells, doubled quotes, commas, semicolons or tabs, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.slice(0, src.search(/\r?\n/) === -1 ? src.length : src.search(/\r?\n/));
  const sep = detectSeparator(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") { quoted = true; continue; }
    if (ch === sep) { row.push(cell); cell = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function detectSeparator(line: string): string {
  const counts = [",", ";", "\t"].map((s) => ({ s, n: line.split(s).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].s : ",";
}

export const CSV_FIELDS = ["email", "name", "firstName", "lastName", "phone", "title", "company", "notes"] as const;
export type CsvField = (typeof CSV_FIELDS)[number];
export const CSV_FIELD_LABELS: Record<CsvField, string> = {
  email: "Email", name: "Full name", firstName: "First name", lastName: "Last name", phone: "Phone", title: "Job title", company: "Company", notes: "Notes",
};
/** Column index per field; -1 = not imported. */
export type CsvMapping = Record<CsvField, number>;

const HINTS: Record<CsvField, RegExp> = {
  email: /^(e-?mail|email address|e-?mail address|work email|primary email)$/i,
  name: /^(name|full name|contact|contact name|display name)$/i,
  firstName: /^(first|first name|given name|firstname|forename)$/i,
  lastName: /^(last|last name|surname|family name|lastname)$/i,
  phone: /^(phone|phone number|mobile|mobile phone|cell|telephone|tel|work phone)$/i,
  title: /^(title|job title|position|role)$/i,
  company: /^(company|company name|organisation|organization|account|business)$/i,
  notes: /^(notes?|comments?|description)$/i,
};

/** Guesses each field's column from the header row. Each column is used once. */
export function guessMapping(headers: string[]): CsvMapping {
  const out = Object.fromEntries(CSV_FIELDS.map((f) => [f, -1])) as CsvMapping;
  const used = new Set<number>();
  for (const f of CSV_FIELDS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && HINTS[f].test(h.trim()));
    if (i >= 0) { out[f] = i; used.add(i); }
  }
  if (out.email < 0) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && /mail/i.test(h));
    if (i >= 0) { out.email = i; used.add(i); }
  }
  return out;
}

export interface CsvContact { email: string; name: string; phone?: string; title?: string; company?: string; notes?: string }
export interface CsvCheck {
  rows: CsvContact[];
  invalid: { line: number; reason: string }[];
  duplicatesInFile: number;
  total: number;
  tooMany: boolean;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const cut = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);

/** Maps data rows (header excluded) to contacts. Bad emails are listed by line; a repeated email keeps its first row. */
export function checkRows(data: string[][], mapping: CsvMapping, headerLines = 1): CsvCheck {
  const seen = new Set<string>();
  const rows: CsvContact[] = [];
  const invalid: { line: number; reason: string }[] = [];
  let duplicatesInFile = 0;
  const limited = data.slice(0, CSV_MAX_ROWS);
  limited.forEach((r, i) => {
    const line = i + 1 + headerLines;
    const at = (f: CsvField) => (mapping[f] >= 0 ? r[mapping[f]] ?? "" : "");
    const email = at("email").trim().toLowerCase().replace(/^mailto:/, "");
    if (!email) { invalid.push({ line, reason: "No email" }); return; }
    if (!EMAIL.test(email) || email.length > 254) { invalid.push({ line, reason: "Email looks wrong" }); return; }
    if (seen.has(email)) { duplicatesInFile++; return; }
    seen.add(email);
    const full = cut(at("name"), 120) || cut([at("firstName"), at("lastName")].map((x) => x.trim()).filter(Boolean).join(" "), 120);
    rows.push({
      email, name: full,
      ...(cut(at("phone"), 40) ? { phone: cut(at("phone"), 40) } : {}),
      ...(cut(at("title"), 120) ? { title: cut(at("title"), 120) } : {}),
      ...(cut(at("company"), 120) ? { company: cut(at("company"), 120) } : {}),
      ...(cut(at("notes"), 2000) ? { notes: cut(at("notes"), 2000) } : {}),
    });
  });
  return { rows, invalid, duplicatesInFile, total: data.length, tooMany: data.length > CSV_MAX_ROWS };
}
