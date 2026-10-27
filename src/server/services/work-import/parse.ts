/**
 * Reading the files other work tools export: Trello board JSON, and the CSV files from Asana,
 * ClickUp, monday, Jira, Linear and Notion. Everything becomes one table (headers and rows), the
 * source is guessed from the headers, and a mapping says which column feeds which task field.
 * Pure functions with no database access, so the web preview and the import read the same way.
 */
import Papa from "papaparse";
import { strFromU8, unzipSync } from "fflate";
import { fromB64Or } from "../../lib/crypto";

export type WorkSource = "trello" | "asana" | "clickup" | "monday" | "jira" | "linear" | "notion" | "todoist" | "csv";
export type Category = "todo" | "doing" | "done";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export const SOURCE_LABELS: Record<WorkSource, string> = {
  trello: "Trello", asana: "Asana", clickup: "ClickUp", monday: "monday.com", jira: "Jira", linear: "Linear", notion: "Notion", todoist: "Todoist", csv: "CSV file",
};

/** Task fields a column can feed. `id` keeps re-runs from making copies; `completed` marks done rows. */
export const MAP_FIELDS = ["id", "title", "status", "statusGroup", "completed", "assignee", "due", "start", "priority", "labels", "parent", "description", "comments"] as const;
export type MapField = (typeof MAP_FIELDS)[number];
export type Mapping = Partial<Record<MapField, string | null>>;

export const FIELD_LABELS: Record<MapField, string> = {
  id: "Source id", title: "Title", status: "Status", statusGroup: "Status group", completed: "Completed", assignee: "Assignee", due: "Due date",
  start: "Start date", priority: "Priority", labels: "Labels", parent: "Parent", description: "Description", comments: "Comments",
};

export interface Table { source: WorkSource; headers: string[]; rows: string[][]; scope: string; name: string | null }

export interface ImportRow {
  externalId: string;
  title: string;
  status: string | null;
  category: Category | null;
  assignees: string[];
  due: Date | null;
  start: Date | null;
  priority: Priority;
  labels: string[];
  parent: string | null;
  description: string;
  comments: string[];
}

export class ImportFileError extends Error {}

// ------------------------------------------------------------------ reading

export const MAX_FILE_CHARS = 8_000_000;

/** Reads the uploaded text: JSON (Trello) or CSV with any header row in the first lines. */
export function readTable(text: string, fileName = ""): Table {
  if (text.length > MAX_FILE_CHARS) throw new ImportFileError("This file is over 8 MB. Export a smaller part, or split it.");
  const body = text.replace(/^\uFEFF/, "");
  if (/^\s*[[{]/.test(body)) {
    let json: unknown;
    try { json = JSON.parse(body); } catch { throw new ImportFileError("This JSON file could not be read."); }
    if (isTrello(json)) return trelloTable(json);
    throw new ImportFileError("This JSON file is not a Trello board export. For other tools, export a CSV file.");
  }
  let all: string[][];
  if (body.startsWith(ZIP_PREFIX)) return zipTable(body.slice(ZIP_PREFIX.length));
  if (body.startsWith(XLSX_PREFIX)) all = xlsxRows(body.slice(XLSX_PREFIX.length));
  else if (body.startsWith("PK\u0003\u0004") || /\.xls$/i.test(fileName)) throw new ImportFileError("This Excel file could not be read. Save it as CSV (or .xlsx) and upload that.");
  else all = (Papa.parse<string[]>(body, { skipEmptyLines: "greedy" }).data as string[][]).filter((r) => Array.isArray(r));
  if (!all.length) throw new ImportFileError("This file is empty.");
  // monday puts the board name and group names above the header row; take the first row with 3 or more filled cells.
  let h = all.findIndex((r) => r.filter((c) => c.trim()).length >= 3);
  if (h < 0 || h > 5) h = 0;
  const headers = all[h].map((c) => c.trim());
  const width = headers.length;
  const rows = all.slice(h + 1).filter((r) => r.length >= Math.min(2, width) && r.some((c) => c.trim()) && !isGroupRow(r, width));
  if (isTodoist(headers)) return todoistTable(headers, rows, fileName);
  const source = detectSource(headers);
  const name = h > 0 ? all[0].find((c) => c.trim())?.trim() ?? null : null;
  return { source, headers, rows, scope: "", name };
}

/** R38: a .zip (the Markdown and CSV export of a notes and wiki tool) arrives as this prefix and the file in base64. */
export const ZIP_PREFIX = "zip-base64:";

/** R49: an uploaded file in base64 (or base64url); a body that is not base64 is an ImportFileError (422), never a 500. */
export function base64Bytes(base64: string) {
  return fromB64Or(base64, () => new ImportFileError(UNREADABLE_FILE));
}

/** R49: the plain answer when an uploaded body is not base64. */
export const UNREADABLE_FILE = "This file could not be read. Export it again and try once more.";

/** The files in an uploaded zip, by path (text only, folders skipped, at most 2,000 files). */
export function zipTexts(base64: string, keep: (name: string) => boolean): Map<string, string> {
  let files: Record<string, Uint8Array>;
  let n = 0;
  try { files = unzipSync(base64Bytes(base64), { filter: (f) => !f.name.endsWith("/") && keep(f.name) && ++n <= 2000 }); }
  catch { throw new ImportFileError("This zip file could not be read."); }
  return new Map(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

/** "Plan launch 0f3c9a...e1.md" to "Plan launch": the page title without the 32 character id the export adds. */
export const pageTitle = (path: string) => (path.split("/").pop() ?? path).replace(/\.(md|csv)$/i, "").replace(/\s+[0-9a-f]{32}$/i, "").replace(/_all$/i, "").trim();

/** Markdown page body without its "# Title" line and the "Key: value" property lines under it. */
export function pageBody(md: string) {
  const lines = md.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  if (/^#\s/.test(lines[0] ?? "")) i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const start = i;
  while (i < lines.length && /^[A-Z][\w ()/.-]{0,40}:\s/.test(lines[i])) i++;
  if (i > start && (i === lines.length || !lines[i].trim())) return lines.slice(i).join("\n").trim();
  return lines.slice(start).join("\n").trim();
}

/** A Markdown and CSV zip: the database CSV becomes rows, and each row's own page becomes its description. */
function zipTable(base64: string): Table {
  const texts = zipTexts(base64, (n) => /\.(csv|md)$/i.test(n) && !n.startsWith("__MACOSX"));
  const csvs = [...texts.keys()].filter((k) => /\.csv$/i.test(k)).sort((a, b) => Number(/_all\.csv$/i.test(b)) - Number(/_all\.csv$/i.test(a)) || a.length - b.length);
  if (!csvs.length) throw new ImportFileError("This zip has no table (CSV) in it. To bring in pages, choose Docs instead.");
  const t = readTable(texts.get(csvs[0])!, csvs[0]);
  const pages = new Map<string, string>();
  for (const [k, v] of texts) if (/\.md$/i.test(k)) pages.set(pageTitle(k).toLowerCase(), pageBody(v));
  const titleAt = defaultMapping(t).title ? t.headers.indexOf(defaultMapping(t).title!) : 0;
  const headers = [...t.headers, "Page"];
  const rows = t.rows.map((r) => [...r, pages.get((r[titleAt] ?? "").trim().toLowerCase()) ?? ""]);
  return { ...t, source: t.source === "csv" ? "notion" : t.source, headers, rows, name: t.name ?? pageTitle(csvs[0]) };
}

// ------------------------------------------------------------------ Todoist

const TODOIST_HEADERS = ["Task ID", "Content", "Section", "Priority", "Responsible", "Date", "Deadline", "Parent ID", "Description", "Labels", "Comments"];
const isTodoist = (headers: string[]) => ["TYPE", "CONTENT", "INDENT"].every((n) => headers.some((h) => h.toUpperCase() === n));
const TODOIST_PRIORITY: Record<string, string> = { "1": "Urgent", "2": "High", "3": "Medium", "4": "" };

/**
 * A task list CSV: TYPE (task, section, note), CONTENT, DESCRIPTION, PRIORITY (1 is the highest), INDENT (1 top level,
 * 2 a subtask of the task above, and so on), RESPONSIBLE ("Name (id)"), DATE, DEADLINE. A section names the column the
 * tasks under it sit in, and a note is a comment on the task above it. Labels ride in the task name as @label.
 */
function todoistTable(headers: string[], rows: string[][], fileName: string): Table {
  const col = (n: string) => headers.findIndex((h) => h.toUpperCase() === n);
  const [type, content, desc, prio, indent, resp, date, deadline] = ["TYPE", "CONTENT", "DESCRIPTION", "PRIORITY", "INDENT", "RESPONSIBLE", "DATE", "DEADLINE"].map(col);
  const out: { cells: string[]; comments: string[] }[] = [];
  let section = "";
  const stack: string[] = [];
  for (const r of rows) {
    const kind = (r[type] ?? "").trim().toLowerCase();
    const text = (r[content] ?? "").trim();
    if (kind === "section") { section = text; stack.length = 0; continue; }
    if (kind === "note") { out.at(-1)?.comments.push(text); continue; }
    if (kind !== "task" || !text) continue;
    const id = `todoist-${out.length + 1}`;
    const level = Math.max(1, Number.parseInt(r[indent] ?? "1", 10) || 1);
    stack.length = level - 1;
    const parent = stack[level - 2] ?? "";
    stack[level - 1] = id;
    const labels = [...text.matchAll(/(?:^|\s)@([\w-]+)/g)].map((m) => m[1]);
    const title = text.replace(/(?:^|\s)@[\w-]+/g, "").trim() || text;
    out.push({
      cells: [id, title, section, TODOIST_PRIORITY[(r[prio] ?? "").trim()] ?? "", (r[resp] ?? "").replace(/\s*\(\d+\)\s*$/, "").trim(),
        (r[date] ?? "").trim(), deadline >= 0 ? (r[deadline] ?? "").trim() : "", parent, desc >= 0 ? (r[desc] ?? "").trim() : "", labels.join(", ")],
      comments: [],
    });
  }
  const most = Math.max(1, ...out.map((o) => o.comments.length));
  return {
    source: "todoist", headers: [...TODOIST_HEADERS.slice(0, -1), ...Array.from({ length: most }, () => "Comments")],
    rows: out.map((o) => [...o.cells, ...Array.from({ length: most }, (_, i) => o.comments[i] ?? "")]),
    scope: "", name: fileName ? fileName.replace(/\.csv$/i, "") : null,
  };
}

/** An .xlsx file arrives as this prefix and the file in base64 (the browser reads it as bytes). */
export const XLSX_PREFIX = "xlsx-base64:";

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()] ?? "");
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join("");
const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first sheet of an .xlsx workbook as rows of text (fflate unzips; the sheet XML is simple enough to read directly). */
export function xlsxRows(base64: string): string[][] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(base64Bytes(base64), { filter: (f) => f.name === "xl/sharedStrings.xml" || f.name.startsWith("xl/worksheets/sheet") });
  } catch { throw new ImportFileError("This Excel file could not be read. Save it as CSV and upload that."); }
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))[0];
  if (!sheetName) throw new ImportFileError("This Excel file has no sheet to read.");
  const shared = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const rows: string[][] = [];
  for (const rm of strFromU8(files[sheetName]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
      const value = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? textOf(inner) : unxml(v);
      const at = ref ? colIndex(ref) : row.length;
      while (row.length < at) row.push("");
      row[at] = value;
    }
    rows.push(row);
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => [...r, ...Array.from({ length: width - r.length }, () => "")]);
}

/** A monday group heading (one filled cell, or the header row repeated under each group). */
function isGroupRow(r: string[], width: number) {
  const filled = r.filter((c) => c.trim()).length;
  return width >= 3 && filled === 1 && r[0]?.trim() !== "";
}

// ------------------------------------------------------------------ Trello

interface TrelloBoard {
  id: string; name?: string;
  lists: { id: string; name: string; closed?: boolean; pos?: number }[];
  cards: { id: string; name: string; desc?: string; idList: string; idMembers?: string[]; idLabels?: string[]; due?: string | null; start?: string | null; dueComplete?: boolean; closed?: boolean; pos?: number; idChecklists?: string[] }[];
  members?: { id: string; fullName?: string; username?: string }[];
  labels?: { id: string; name?: string; color?: string }[];
  checklists?: { id: string; idCard: string; checkItems?: { id: string; name: string; state?: string; due?: string | null; pos?: number }[] }[];
  actions?: { type: string; data?: { text?: string; card?: { id: string } }; memberCreator?: { fullName?: string }; date?: string }[];
}

function isTrello(j: unknown): j is TrelloBoard {
  const o = j as Partial<TrelloBoard> | null;
  return !!o && typeof o === "object" && Array.isArray(o.cards) && Array.isArray(o.lists);
}

const TRELLO_HEADERS = ["Card ID", "Card Name", "List", "Members", "Labels", "Due Date", "Start Date", "Due Complete", "Description", "Parent Card"];

function trelloTable(b: TrelloBoard): Table {
  const lists = new Map(b.lists.map((l) => [l.id, l]));
  const members = new Map((b.members ?? []).map((m) => [m.id, m.fullName || m.username || ""]));
  const labels = new Map((b.labels ?? []).map((l) => [l.id, l.name || l.color || ""]));
  const comments = new Map<string, string[]>();
  for (const a of [...(b.actions ?? [])].reverse()) {
    if (a.type !== "commentCard" || !a.data?.card?.id || !a.data.text) continue;
    const who = a.memberCreator?.fullName;
    comments.set(a.data.card.id, [...(comments.get(a.data.card.id) ?? []), who ? `${who}: ${a.data.text}` : a.data.text]);
  }
  const maxComments = Math.max(0, ...[...comments.values()].map((c) => c.length));
  const headers = [...TRELLO_HEADERS, ...Array.from({ length: maxComments }, () => "Comment")];
  const open = b.cards.filter((c) => !c.closed && lists.get(c.idList) && !lists.get(c.idList)!.closed)
    .sort((x, y) => (lists.get(x.idList)!.pos ?? 0) - (lists.get(y.idList)!.pos ?? 0) || (x.pos ?? 0) - (y.pos ?? 0));
  const rows: string[][] = [];
  for (const c of open) {
    const cs = comments.get(c.id) ?? [];
    rows.push([c.id, c.name, lists.get(c.idList)!.name, (c.idMembers ?? []).map((m) => members.get(m)).filter(Boolean).join(", "),
      (c.idLabels ?? []).map((l) => labels.get(l)).filter(Boolean).join(", "), c.due ?? "", c.start ?? "", c.dueComplete ? "true" : "", c.desc ?? "", "",
      ...Array.from({ length: maxComments }, (_, i) => cs[i] ?? "")]);
    // Checklist items become subtasks of their card; a ticked item is done.
    for (const cl of (b.checklists ?? []).filter((x) => x.idCard === c.id)) {
      for (const it of [...(cl.checkItems ?? [])].sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0))) {
        rows.push([it.id, it.name, it.state === "complete" ? "Done" : lists.get(c.idList)!.name, "", "", it.due ?? "", "", it.state === "complete" ? "true" : "", "", c.id,
          ...Array.from({ length: maxComments }, () => "")]);
      }
    }
  }
  return { source: "trello", headers, rows, scope: b.id, name: b.name ?? null };
}

/** The Trello list order, so the new project's statuses follow the board's columns. */
export function trelloListOrder(text: string): string[] {
  try {
    const j = JSON.parse(text.replace(/^\uFEFF/, "")) as TrelloBoard;
    return isTrello(j) ? j.lists.filter((l) => !l.closed).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0)).map((l) => l.name) : [];
  } catch { return []; }
}

// ------------------------------------------------------------------ detection and mapping

const has = (headers: string[], ...names: string[]) => names.every((n) => headers.some((h) => h.toLowerCase() === n.toLowerCase()));

export function detectSource(headers: string[]): WorkSource {
  if (has(headers, "Task ID", "Section/Column") || has(headers, "Task ID", "Parent task") || has(headers, "Assignee Email", "Section/Column")) return "asana";
  if (has(headers, "Task ID", "Task Name")) return "clickup";
  if (has(headers, "Issue key", "Summary") || has(headers, "Issue id", "Summary")) return "jira";
  if (has(headers, "ID", "Title") && (has(headers, "Parent issue") || has(headers, "Team") || has(headers, "Cycle Name"))) return "linear";
  if (has(headers, "Name") && (has(headers, "Item ID") || has(headers, "Subitems") || has(headers, "Person"))) return "monday";
  if (has(headers, "Name") && (has(headers, "Created time") || has(headers, "Last edited time") || has(headers, "Assign") || has(headers, "Assignee"))) return "notion";
  return "csv";
}

const DEFAULTS: Record<WorkSource, Partial<Record<MapField, string[]>>> = {
  trello: { id: ["Card ID"], title: ["Card Name"], status: ["List"], assignee: ["Members"], due: ["Due Date"], start: ["Start Date"], labels: ["Labels"], parent: ["Parent Card"], description: ["Description"], comments: ["Comment"] },
  asana: { id: ["Task ID"], title: ["Name"], status: ["Section/Column"], completed: ["Completed At"], assignee: ["Assignee Email", "Assignee"], due: ["Due Date"], start: ["Start Date"], priority: ["Priority"], labels: ["Tags"], parent: ["Parent task"], description: ["Notes"], comments: ["Comments"] },
  clickup: { id: ["Task ID"], title: ["Task Name"], status: ["Status"], assignee: ["Assignees", "Assignee"], due: ["Due Date"], start: ["Start Date"], priority: ["Priority"], labels: ["Tags"], parent: ["Parent ID", "Parent"], description: ["Task Content", "Description"], comments: ["Comments"] },
  monday: { id: ["Item ID"], title: ["Name"], status: ["Status"], assignee: ["Person", "Owner", "People"], due: ["Date", "Due date", "Due Date", "Deadline"], start: ["Start date", "Start Date"], priority: ["Priority"], labels: ["Tags", "Labels"], parent: ["Parent item", "Parent Item ID"], description: ["Notes", "Description", "Text"], comments: ["Updates", "Comments"] },
  jira: { id: ["Issue id"], title: ["Summary"], status: ["Status"], statusGroup: ["Status Category"], assignee: ["Assignee"], due: ["Due date", "Due Date"], start: ["Start date", "Start Date"], priority: ["Priority"], labels: ["Labels"], parent: ["Parent id", "Parent"], description: ["Description"], comments: ["Comment"] },
  linear: { id: ["ID"], title: ["Title"], status: ["Status"], completed: ["Completed"], assignee: ["Assignee"], due: ["Due Date", "Due date"], priority: ["Priority"], labels: ["Labels"], parent: ["Parent issue"], description: ["Description"] },
  todoist: { id: ["Task ID"], title: ["Content"], status: ["Section"], assignee: ["Responsible"], due: ["Deadline", "Date"], priority: ["Priority"], labels: ["Labels"], parent: ["Parent ID"], description: ["Description"], comments: ["Comments"] },
  notion: { title: ["Name", "Task name", "Title"], status: ["Status"], assignee: ["Assign", "Assignee", "Assignees", "Person"], due: ["Due", "Due date", "Date", "Deadline"], start: ["Start", "Start date"], priority: ["Priority"], labels: ["Tags", "Labels"], parent: ["Parent item", "Parent task", "Parent"], description: ["Page", "Description", "Notes"], comments: ["Comments"] },
  csv: { id: ["ID", "Id", "Key", "Task ID"], title: ["Title", "Name", "Task", "Summary", "Task Name"], status: ["Status", "State", "Stage", "List", "Column"], completed: ["Completed", "Done", "Completed At"], assignee: ["Assignee Email", "Assignee", "Owner", "Assigned to", "Person"], due: ["Due", "Due date", "Due Date", "Deadline"], start: ["Start", "Start date", "Start Date"], priority: ["Priority"], labels: ["Labels", "Tags"], parent: ["Parent", "Parent ID", "Parent task"], description: ["Description", "Notes", "Details"], comments: ["Comments", "Comment"] },
};

/** The preselected mapping: the first header present from each field's candidates. */
export function defaultMapping(t: Pick<Table, "source" | "headers">): Mapping {
  const out: Mapping = {};
  for (const f of MAP_FIELDS) {
    const hit = (DEFAULTS[t.source][f] ?? []).find((n) => t.headers.some((h) => h.toLowerCase() === n.toLowerCase()));
    out[f] = hit ? t.headers.find((h) => h.toLowerCase() === hit.toLowerCase())! : null;
  }
  if (!out.title) out.title = t.headers[0] ?? null;
  return out;
}

/** Unique header names, for the mapping menus (Jira repeats "Labels" and "Comment"). */
export const uniqueHeaders = (headers: string[]) => [...new Set(headers.filter(Boolean))];

// ------------------------------------------------------------------ values

const DONE = /\b(done|complete|completed|closed|resolved|finished|shipped|released|deployed|merged|archived|cancel+ed|won'?t (do|fix)|duplicate)\b/i;
const DOING = /\b(progress|doing|review|reviewing|testing|test|qa|started|active|working|blocked|stuck|waiting|in dev|development|building|design)\b/i;

export function categoryOf(status: string): Category {
  if (/\b(not started|unstarted|to ?do|backlog|new|open)\b/i.test(status) && !/\bre-?open/i.test(status)) return "todo";
  if (DONE.test(status)) return "done";
  if (DOING.test(status)) return "doing";
  return "todo";
}

/** Jira's "Status Category" and similar group columns. */
function groupOf(v: string): Category | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (/^(done|complete|completed|closed)$/.test(s)) return "done";
  if (/(progress|doing|started|active)/.test(s)) return "doing";
  if (/^(to ?do|todo|new|open|backlog|unstarted|not started)$/.test(s)) return "todo";
  return null;
}

const truthy = (v: string) => !!v.trim() && !/^(false|no|0|n|unchecked|incomplete|not done)$/i.test(v.trim());

export function priorityOf(v: string): Priority {
  const s = v.trim().toLowerCase();
  if (!s) return "none";
  if (/(urgent|highest|critical|blocker|^p0$|^0$|^1 ?- ?urgent)/.test(s)) return "urgent";
  if (/(high|^p1$|major|^2$)/.test(s)) return "high";
  if (/(medium|normal|moderate|^p2$|^3$)/.test(s)) return "medium";
  if (/(low|minor|trivial|^p3$|^p4$|^4$)/.test(s)) return "low";
  return "none";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Dates as the tools write them: ISO, epoch milliseconds, 25/Oct/26, October 25th 2026, 10/25/2026. Null when unreadable. */
export function parseLooseDate(v: string): Date | null {
  let s = v.trim();
  if (!s) return null;
  if (/^\d{11,13}$/.test(s)) return new Date(Number(s));
  // An Excel date serial (days since 30 December 1899), as .xlsx cells hold dates.
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Math.floor(Number(s)); return n > 20_000 && n < 80_000 ? valid(new Date(Date.UTC(1899, 11, 30, 12) + n * 86_400_000)) : null; }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return utc(+m[1], +m[2], +m[3]);
  if (/^\d{4}-\d{2}-\d{2}[T ]\d/.test(s)) { const d = new Date(s.replace(" ", "T")); return valid(d); }
  // Jira: 25/Oct/26 10:00 AM
  m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2,4})/.exec(s);
  if (m) { const mo = MONTHS.indexOf(m[2].toLowerCase()); if (mo >= 0) return utc(year(m[3]), mo + 1, +m[1]); }
  // Slashes: day first when the first part is over 12, else month first (the US form the tools export).
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(s);
  if (m) { const a = +m[1], b = +m[2]; return a > 12 ? utc(year(m[3]), b, a) : utc(year(m[3]), a, b); }
  // Words: "Monday, October 25th 2026", "October 25, 2026", "25 Oct 2026"
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*/i, "").replace(/(\d)(st|nd|rd|th)\b/gi, "$1").replace(/\s+\d{1,2}:\d{2}.*$/, "");
  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); if (mo >= 0) return utc(+m[3], mo + 1, +m[2]); }
  m = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/.exec(s);
  if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mo >= 0) return utc(+m[3], mo + 1, +m[1]); }
  return null;
}
const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
const valid = (d: Date) => (Number.isNaN(d.getTime()) ? null : d);
function utc(y: number, mo: number, d: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return valid(new Date(Date.UTC(y, mo - 1, d, 12)));
}

const splitList = (v: string) => v.replace(/^\[|\]$/g, "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/** Jira writes comments as "date;author id;text". Keep the text. */
function cleanComment(v: string) {
  const m = /^\d{1,2}\/[A-Za-z]{3}\/\d{2,4}[^;]*;[^;]*;([\s\S]*)$/.exec(v);
  return (m ? m[1] : v).trim();
}

/** Turns table rows into task rows with the mapping. Rows with no title are left out. */
export function mapRows(t: Table, mapping: Mapping): { rows: ImportRow[]; skipped: number } {
  const idx = (f: MapField) => {
    const name = mapping[f];
    if (!name) return [] as number[];
    return t.headers.map((h, i) => (h === name ? i : -1)).filter((i) => i >= 0);
  };
  const cols = Object.fromEntries(MAP_FIELDS.map((f) => [f, idx(f)])) as Record<MapField, number[]>;
  const first = (r: string[], f: MapField) => { for (const i of cols[f]) { const v = (r[i] ?? "").trim(); if (v) return v; } return ""; };
  const all = (r: string[], f: MapField) => cols[f].map((i) => (r[i] ?? "").trim()).filter(Boolean);
  const out: ImportRow[] = [];
  let skipped = 0;
  const seen = new Map<string, number>();
  t.rows.forEach((r, n) => {
    const title = first(r, "title").replace(/\s+/g, " ").slice(0, 500);
    if (!title) { skipped++; return; }
    let externalId = first(r, "id") || `row:${title.toLowerCase()}`;
    // Same id twice in one file (or two rows with the same title and no id): number the repeats.
    const k = seen.get(externalId) ?? 0;
    seen.set(externalId, k + 1);
    if (k) externalId = `${externalId}#${k + 1}`;
    void n;
    const status = first(r, "status") || null;
    const done = cols.completed.length ? truthy(first(r, "completed")) : false;
    const group = groupOf(first(r, "statusGroup"));
    out.push({
      externalId, title, status,
      category: done ? "done" : group ?? (status ? categoryOf(status) : null),
      assignees: all(r, "assignee").flatMap(splitList),
      due: parseLooseDate(first(r, "due")),
      start: parseLooseDate(first(r, "start")),
      priority: priorityOf(first(r, "priority")),
      labels: [...new Set(all(r, "labels").flatMap(splitList))].slice(0, 20),
      parent: first(r, "parent") || null,
      description: all(r, "description").join("\n\n").slice(0, 50_000),
      comments: all(r, "comments").map(cleanComment).filter(Boolean).map((c) => c.slice(0, 10_000)),
    });
  });
  return { rows: out, skipped };
}
