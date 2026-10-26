/**
 * R38 move your data: everything outside mail in the workspace export ZIP. Read only (no D1 writes).
 *   data/<table>.json  every work table as JSON (the full record, ids included, so another tool or a script can rebuild links)
 *   csv/<name>.csv     the main tables as spreadsheets with names in place of ids (tasks, projects, comments, contacts,
 *                      companies, deals, time entries, chat messages)
 *   docs/<title>.md    each doc as Markdown
 *   calendar/meetings.ics, contacts/contacts.vcf
 * Secrets and private links never go in: guest meeting links, form and share tokens, hook secrets.
 */
import { asc, eq, gt, and } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableColumns } from "drizzle-orm";
import type { Deps } from "../../context";
import {
  automations, boardSettings, bookings, chatChannels, chatMembers, chatMessages, chatReactions, companies, contacts, customFields, dashboards,
  deals, docLinks, docs, entityLinks, formSubmissions, forms, goals, keyResults, meetingActionItems, meetings, members, projectStatuses, projects,
  savedViews, schedulingPages, sprints, taskChecklistItems, taskComments, taskFieldValues, taskWatchers, tasks, templates, threadComments,
  timeEntries, users,
} from "../../db/schema";
import { docToMarkdown, toIcs, toVcard } from "./formats";

const PAGE = 500;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTable = SQLiteTable & Record<string, any>;

/** Tables in the export and the columns left out of them (tokens that open something without signing in). */
export const EXPORT_TABLES: { name: string; table: AnyTable; omit?: string[] }[] = [
  { name: "projects", table: projects as AnyTable },
  { name: "project_statuses", table: projectStatuses as AnyTable },
  { name: "tasks", table: tasks as AnyTable },
  { name: "task_comments", table: taskComments as AnyTable },
  { name: "task_checklist_items", table: taskChecklistItems as AnyTable },
  { name: "task_watchers", table: taskWatchers as AnyTable },
  { name: "custom_fields", table: customFields as AnyTable },
  { name: "task_field_values", table: taskFieldValues as AnyTable },
  { name: "board_settings", table: boardSettings as AnyTable },
  { name: "entity_links", table: entityLinks as AnyTable },
  { name: "sprints", table: sprints as AnyTable },
  { name: "goals", table: goals as AnyTable },
  { name: "key_results", table: keyResults as AnyTable },
  { name: "time_entries", table: timeEntries as AnyTable },
  { name: "saved_views", table: savedViews as AnyTable },
  { name: "dashboards", table: dashboards as AnyTable },
  { name: "templates", table: templates as AnyTable },
  { name: "automations", table: automations as AnyTable },
  { name: "docs", table: docs as AnyTable },
  { name: "doc_links", table: docLinks as AnyTable },
  { name: "meetings", table: meetings as AnyTable, omit: ["guestToken", "room"] },
  { name: "meeting_action_items", table: meetingActionItems as AnyTable },
  { name: "scheduling_pages", table: schedulingPages as AnyTable },
  { name: "bookings", table: bookings as AnyTable, omit: ["manageToken", "cancelToken"] },
  { name: "companies", table: companies as AnyTable },
  { name: "contacts", table: contacts as AnyTable },
  { name: "deals", table: deals as AnyTable },
  { name: "forms", table: forms as AnyTable, omit: ["token", "publicToken"] },
  { name: "form_submissions", table: formSubmissions as AnyTable },
  { name: "chat_channels", table: chatChannels as AnyTable },
  { name: "chat_members", table: chatMembers as AnyTable },
  { name: "chat_messages", table: chatMessages as AnyTable },
  { name: "chat_reactions", table: chatReactions as AnyTable },
  { name: "thread_comments", table: threadComments as AnyTable },
];

/** Every row of one table for one workspace, a page at a time (by id when the table has one). */
export async function* rowsOf(deps: Deps, table: AnyTable, orgId: string): AsyncGenerator<Record<string, unknown>[]> {
  const cols = getTableColumns(table);
  if (!cols.orgId) return;
  if (!cols.id) {
    const all = await deps.db.select().from(table).where(eq(cols.orgId, orgId)).limit(100_000);
    if (all.length) yield all as Record<string, unknown>[];
    return;
  }
  let cursor = "";
  for (;;) {
    const page = await deps.db.select().from(table).where(and(eq(cols.orgId, orgId), cursor ? gt(cols.id, cursor) : undefined)).orderBy(asc(cols.id)).limit(PAGE) as Record<string, unknown>[];
    if (!page.length) return;
    yield page;
    cursor = String(page[page.length - 1].id);
    if (page.length < PAGE) return;
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? "");
const cell = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvLine = (values: unknown[]) => values.map(cell).join(",") + "\r\n";
const safeName = (s: string) => (s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled");

export interface ZipSink { file(name: string): { push(text: string): void; end(): void } }

/** Rows written per area, for the export summary and the import round trip. */
export type ExportCounts = Record<string, number>;

export async function writeWorkData(deps: Deps, orgId: string, zip: ZipSink): Promise<ExportCounts> {
  const counts: ExportCounts = {};
  // 1. JSON per table.
  for (const t of EXPORT_TABLES) {
    const f = zip.file(`data/${t.name}.json`);
    f.push("[");
    let n = 0;
    for await (const page of rowsOf(deps, t.table, orgId)) {
      for (const r of page) {
        for (const k of t.omit ?? []) delete r[k];
        f.push(`${n ? "," : ""}\n${JSON.stringify(r)}`);
        n++;
      }
    }
    f.push(n ? "\n]\n" : "]\n");
    f.end();
    counts[t.name] = n;
  }

  // 2. Spreadsheets with names in place of ids.
  const people = new Map((await deps.db.select({ id: users.id, email: users.email, name: users.name }).from(members).innerJoin(users, eq(users.id, members.userId)).where(eq(members.organizationId, orgId)))
    .map((u) => [u.id, u]));
  const who = (id: unknown) => (typeof id === "string" ? people.get(id)?.email ?? "" : "");
  const projectRows = await deps.db.select().from(projects).where(eq(projects.orgId, orgId));
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const statusRows = await deps.db.select({ id: projectStatuses.id, name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.orgId, orgId));
  const statusName = new Map(statusRows.map((s) => [s.id, s.name]));

  const pf = zip.file("csv/projects.csv");
  pf.push(csvLine(["Project", "Key", "Description", "Created", "Archived"]));
  for (const p of projectRows) {
    const r = p as Record<string, unknown>;
    pf.push(csvLine([p.name, r.key ?? "", r.description ?? "", iso(p.createdAt), iso(r.archivedAt ?? r.deletedAt ?? "")]));
  }
  pf.end();

  const tf = zip.file("csv/tasks.csv");
  tf.push(csvLine(["ID", "Title", "Project", "Status", "Status group", "Assignee", "Priority", "Start date", "Due date", "Labels", "Parent ID", "Description", "Created", "Completed"]));
  const taskTitle = new Map<string, string>();
  for await (const page of rowsOf(deps, tasks as AnyTable, orgId)) {
    for (const t of page) {
      taskTitle.set(String(t.id), String(t.title));
      let labels = "";
      try { labels = (JSON.parse(String(t.labels ?? "[]")) as string[]).join(", "); } catch { labels = ""; }
      tf.push(csvLine([t.id, t.title, projectName.get(String(t.projectId)) ?? "", statusName.get(String(t.statusId)) ?? "", t.status, t.assigneeType === "member" ? who(t.assigneeId) : "",
        t.priority, iso(t.startAt), iso(t.dueAt), labels, t.parentId ?? "", t.notes ?? "", iso(t.createdAt), iso(t.completedAt)]));
    }
  }
  tf.end();

  const cf = zip.file("csv/comments.csv");
  cf.push(csvLine(["Task ID", "Task", "Author", "Comment", "Created"]));
  for await (const page of rowsOf(deps, taskComments as AnyTable, orgId)) {
    for (const c of page) cf.push(csvLine([c.taskId, taskTitle.get(String(c.taskId)) ?? "", c.authorName || who(c.createdByUserId ?? c.authorUserId), c.body, iso(c.createdAt)]));
  }
  cf.end();

  const companyRows = await deps.db.select().from(companies).where(eq(companies.orgId, orgId));
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
  const cof = zip.file("csv/companies.csv");
  cof.push(csvLine(["Company", "Domain", "Notes", "Created"]));
  for (const c of companyRows) cof.push(csvLine([c.name, c.domain ?? "", c.notes, iso(c.createdAt)]));
  cof.end();

  const ctf = zip.file("csv/contacts.csv");
  const vcf = zip.file("contacts/contacts.vcf");
  ctf.push(csvLine(["Name", "Email", "Phone", "Title", "Company", "Notes", "First contact", "Last contact"]));
  for await (const page of rowsOf(deps, contacts as AnyTable, orgId)) {
    for (const c of page) {
      const company = companyName.get(String(c.companyId)) ?? "";
      ctf.push(csvLine([c.name, c.email, c.phone ?? "", c.title ?? "", company, c.notes ?? "", iso(c.firstContactAt), iso(c.lastContactAt)]));
      vcf.push(toVcard({ name: String(c.name ?? ""), email: String(c.email), phone: c.phone as string | null, title: c.title as string | null, company, notes: c.notes as string | null }) + "\r\n");
    }
  }
  ctf.end();
  vcf.end();

  const df = zip.file("csv/deals.csv");
  df.push(csvLine(["Deal", "Stage", "Value", "Company", "Owner", "Expected close", "Created"]));
  for (const d of await deps.db.select().from(deals).where(eq(deals.orgId, orgId))) {
    df.push(csvLine([d.title, d.stage, (d.valueCents / 100).toFixed(2), companyName.get(String(d.companyId)) ?? "", who(d.ownerUserId), iso(d.expectedCloseAt), iso(d.createdAt)]));
  }
  df.end();

  const tef = zip.file("csv/time-entries.csv");
  tef.push(csvLine(["Person", "Task", "Started", "Ended", "Minutes", "Note"]));
  for await (const page of rowsOf(deps, timeEntries as AnyTable, orgId)) {
    for (const e of page) tef.push(csvLine([who(e.userId), taskTitle.get(String(e.taskId)) ?? "", iso(e.startedAt), iso(e.endedAt), e.durationMin ?? e.minutes ?? "", e.note ?? e.description ?? ""]));
  }
  tef.end();

  const channelName = new Map((await deps.db.select({ id: chatChannels.id, name: chatChannels.name }).from(chatChannels).where(eq(chatChannels.orgId, orgId))).map((c) => [c.id, c.name]));
  const chf = zip.file("csv/chat-messages.csv");
  chf.push(csvLine(["Channel", "From", "Message", "Sent"]));
  for await (const page of rowsOf(deps, chatMessages as AnyTable, orgId)) {
    for (const m of page) chf.push(csvLine([channelName.get(String(m.channelId)) ?? "", m.authorName || who(m.userId ?? m.authorUserId), m.body ?? m.text ?? "", iso(m.createdAt)]));
  }
  chf.end();

  // 3. Docs as Markdown.
  const usedNames = new Set<string>();
  for await (const page of rowsOf(deps, docs as AnyTable, orgId)) {
    for (const d of page) {
      if (d.deletedAt) continue;
      let name = safeName(String(d.title ?? "Untitled"));
      if (usedNames.has(name.toLowerCase())) name = `${name} ${String(d.id).slice(-6)}`;
      usedNames.add(name.toLowerCase());
      const f = zip.file(`docs/${name}.md`);
      f.push(docToMarkdown(String(d.title ?? "Untitled"), String(d.content ?? "")));
      f.end();
    }
  }

  // 4. Calendar.
  const mtgs = await deps.db.select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt, durationMin: meetings.durationMin, recurrence: meetings.recurrence, status: meetings.status, invitees: meetings.invitees, updatedAt: meetings.updatedAt })
    .from(meetings).where(eq(meetings.orgId, orgId)).limit(50_000);
  const ics = zip.file("calendar/meetings.ics");
  ics.push(toIcs(mtgs.map((m) => ({ ...m, invitees: (() => { try { return JSON.parse(m.invitees) as string[]; } catch { return []; } })() }))));
  ics.end();
  return counts;
}

export const EXPORT_README = `Your workspace export

data/      Every record as JSON, one file per table. Ids are kept so links between records can be rebuilt.
csv/       The main tables as spreadsheets: tasks, projects, comments, contacts, companies, deals, time entries, chat.
docs/      Each doc as a Markdown file.
calendar/  Meetings as an iCalendar file (.ics) that any calendar app imports.
contacts/  Contacts as a vCard file (.vcf) that any address book imports.
mail/      Each mailbox as an mbox file (any desktop mail app imports it) and as JSON lines with attachments.
workspace.json, members.csv, audit-log.csv  Settings, people and the audit log.

Passwords, keys and private links are never exported. To bring this export into another workspace, open
Settings, Import and export, choose "Multies export" and pick this file.
`;
