/**
 * R26 (MB-86): turns a parsed task query (src/shared/task-query.ts) into drizzle conditions on `tasks`. Names
 * (statuses, people, projects, sprints) resolve inside SQL subqueries scoped to the caller's workspace, so a value
 * binds one or two variables whatever it matches; the parser caps a query at QUERY_MAX_VALUES values, which keeps
 * every statement under D1's 100 variable limit. A bad query is a 400 with the message and the character position.
 */
import { and, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Deps } from "../../context";
import { tasks } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { dateRange, parseTaskQuery, PRIORITY_RANK, TaskQueryError, type QueryOp, type QueryTerm } from "../../../shared/task-query";
import type { SuiteActor } from "./common";

export interface TaskQueryCtx { deps: Deps; actor: SuiteActor }

const likeText = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const textCond = (v: string, titleOnly = false) => {
  const p = likeText(v);
  return titleOnly ? sql`${tasks.title} like ${p} escape '\\'` : sql`(${tasks.title} like ${p} escape '\\' or ${tasks.notes} like ${p} escape '\\')`;
};
const anyOf = (list: SQL[]) => (list.length === 1 ? list[0] : or(...list)!);

/** col op value; dates bind as epoch milliseconds (the timestamp_ms columns). */
function compare(col: SQL | SQLiteColumn, op: QueryOp, v: Date | number): SQL {
  const val = v instanceof Date ? v.getTime() : v;
  return sql`${col} ${sql.raw(op)} ${val}`;
}

function dateCond(col: SQLiteColumn, op: QueryOp, v: string, now: Date, back: boolean): SQL {
  const r = dateRange(v, now, back);
  // A day offset (7d) is an instant: "=" means that whole day.
  const from = r.instant && op === "=" ? new Date(Date.UTC(r.from.getUTCFullYear(), r.from.getUTCMonth(), r.from.getUTCDate())) : r.from;
  const to = r.instant ? (op === "=" ? new Date(from.getTime() + 86_400_000) : r.from) : r.to;
  switch (op) {
    case "<": return compare(col, "<", from);
    case "<=": return compare(col, "<", to.getTime() === from.getTime() ? new Date(to.getTime() + 1) : to);
    case ">": return compare(col, ">=", to.getTime() === from.getTime() ? new Date(to.getTime() + 1) : to);
    case ">=": return compare(col, ">=", from);
    default: return sql`(${compare(col, ">=", from)} and ${compare(col, "<", to)})`;
  }
}

const PRIORITY_SQL = sql`case ${tasks.priority} when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end`;

function termCond(t: QueryTerm, ctx: TaskQueryCtx): SQL {
  const org = ctx.actor.orgId;
  const now = ctx.deps.now();
  if (t.kind === "text") return textCond(t.value);
  const each = (fn: (v: string) => SQL) => anyOf(t.values.map(fn));
  switch (t.key) {
    case "title": return each((v) => textCond(v, true));
    case "assignee": return each((v) => {
      const l = v.toLowerCase();
      if (l === "me") return ctx.actor.agentId ? and(eq(tasks.assigneeType, "agent"), eq(tasks.assigneeId, ctx.actor.agentId))! : and(eq(tasks.assigneeType, "member"), eq(tasks.assigneeId, ctx.actor.userId))!;
      if (l === "none") return isNull(tasks.assigneeId);
      const m = /^(member|agent):(.+)$/.exec(v);
      if (m) return and(eq(tasks.assigneeType, m[1] as "member" | "agent"), eq(tasks.assigneeId, m[2]))!;
      // A name (whole or first word) or an email, of a member or an agent of this workspace.
      return or(
        and(eq(tasks.assigneeType, "member"), sql`${tasks.assigneeId} in (select u.id from users u join members m on m.user_id = u.id where m.organization_id = ${org} and (lower(u.email) = ${l} or lower(u.name) = ${l} or lower(u.name) like ${`${l} %`}))`),
        and(eq(tasks.assigneeType, "agent"), sql`${tasks.assigneeId} in (select a.id from agents a where a.org_id = ${org} and lower(a.name) = ${l})`),
      )!;
    });
    case "status": return each((v) => {
      const l = v.toLowerCase();
      if (l === "todo" || l === "doing" || l === "done") return eq(tasks.status, l);
      if (l === "open") return ne(tasks.status, "done");
      return sql`${tasks.statusId} in (select s.id from project_statuses s where s.org_id = ${org} and lower(s.name) = ${l} and s.deleted_at is null)`;
    });
    case "label": return each((v) => sql`lower(${tasks.labels}) like ${`%${JSON.stringify(v.toLowerCase()).replace(/[\\%_]/g, (c) => `\\${c}`)}%`} escape '\\'`);
    case "priority": return each((v) => (t.op === "=" ? eq(tasks.priority, v.toLowerCase() as "none") : compare(PRIORITY_SQL, t.op, PRIORITY_RANK[v.toLowerCase()])));
    case "type": return each((v) => eq(tasks.type, v.toLowerCase() as "task"));
    case "due": return each((v) => (v.toLowerCase() === "none" ? isNull(tasks.dueAt) : dateCond(tasks.dueAt, t.op, v, now, false)));
    case "created": return each((v) => dateCond(tasks.createdAt, t.op, v, now, true));
    case "updated": return each((v) => dateCond(tasks.updatedAt, t.op, v, now, true));
    case "points": return each((v) => (v.toLowerCase() === "none" ? isNull(tasks.points) : compare(tasks.points, t.op, Number(v))));
    case "project": return each((v) => sql`${tasks.projectId} in (select p.id from projects p where p.org_id = ${org} and p.deleted_at is null and (upper(p.key) = ${v.toUpperCase()} or lower(p.name) = ${v.toLowerCase()}))`);
    case "sprint": return each((v) => {
      const l = v.toLowerCase();
      if (l === "none" || l === "backlog") return isNull(tasks.sprintId);
      if (l === "current") return sql`${tasks.sprintId} in (select s.id from sprints s where s.org_id = ${org} and s.status = 'active' and s.deleted_at is null)`;
      if (l === "next") return sql`${tasks.sprintId} in (select s.id from sprints s where s.org_id = ${org} and s.status = 'planned' and s.deleted_at is null and s.start_at = (select min(s2.start_at) from sprints s2 where s2.project_id = s.project_id and s2.status = 'planned' and s2.deleted_at is null))`;
      return sql`${tasks.sprintId} in (select s.id from sprints s where s.org_id = ${org} and lower(s.name) = ${l} and s.deleted_at is null)`;
    });
    case "has": return each((v) => {
      switch (v.toLowerCase()) {
        case "subtasks": return sql`exists (select 1 from tasks c where c.parent_id = ${tasks.id} and c.deleted_at is null)`;
        case "checklist": return sql`exists (select 1 from task_checklist_items k where k.task_id = ${tasks.id})`;
        case "due": return isNotNull(tasks.dueAt);
        case "assignee": return isNotNull(tasks.assigneeId);
        case "labels": return ne(tasks.labels, "[]");
        case "points": return isNotNull(tasks.points);
        case "parent": return isNotNull(tasks.parentId);
        default: return ne(tasks.notes, "");
      }
    });
    case "is": return each((v) => {
      switch (v.toLowerCase()) {
        case "overdue": return and(lt(tasks.dueAt, now), ne(tasks.status, "done"))!;
        case "open": return ne(tasks.status, "done");
        case "done": return eq(tasks.status, "done");
        case "unassigned": return isNull(tasks.assigneeId);
        case "subtask": return isNotNull(tasks.parentId);
        default: return termCond({ kind: "field", key: "assignee", op: "=", values: ["me"], negate: false, pos: t.pos }, ctx);
      }
    });
  }
}

/** True when a term should also see subtasks (has:parent, is:subtask). */
export function wantsSubtasks(q: string) {
  try { return parseTaskQuery(q).terms.some((t) => t.kind === "field" && !t.negate && ((t.key === "is" && t.values.includes("subtask")) || (t.key === "has" && t.values.includes("parent")))); } catch { return false; }
}

/**
 * The conditions for a query string, ANDed by the caller with its other filters. A negated term also keeps rows
 * where the column is empty (-assignee:me keeps unassigned tasks).
 */
export function applyTaskQuery(q: string, ctx: TaskQueryCtx): SQL[] {
  let parsed;
  try { parsed = parseTaskQuery(q); } catch (e) {
    if (e instanceof TaskQueryError) throw new HttpError(400, "bad_query", e.message, { position: e.position });
    throw e;
  }
  return parsed.terms.map((t) => {
    const c = termCond(t, ctx);
    return t.negate ? sql`coalesce((${c}), 0) = 0` : c;
  });
}

