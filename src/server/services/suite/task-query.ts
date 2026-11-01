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
import { dateRange, parseTaskQuery, PRIORITY_RANK, TaskQueryError, type HistoryTerm, type QueryNode, type QueryOp, type QueryTerm } from "../../../shared/task-query";
import type { SuiteActor } from "./common";
import { refCond, TASK_REF_RE } from "./task-refs-r34";
import { containsAny, containsText } from "../../lib/like-search";

export interface TaskQueryCtx { deps: Deps; actor: SuiteActor }

/** LK1: instr based, so a long query never meets D1's 50 byte LIKE pattern limit. */
const textCond = (v: string, titleOnly = false) => (titleOnly ? containsText(tasks.title, v) : containsAny([tasks.title, tasks.notes], v));
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

/**
 * R34: history over the task's change rows. Rows written since 0073 live in `changes` (verb set, partial index
 * changes_entity_idx on entity_type, entity_id, seq); older rows in `activity` (activity_entity_idx). Both branches of
 * the UNION ALL are correlated on the task id, so each is an index lookup per candidate task, and the condition binds
 * its values once. A task update row's data holds status { from, to, name, category }, assignee ("member:id",
 * "agent:id" or null) and priority (the new value).
 */
function historyRows(c: SQL): SQL {
  return sql`exists (select 1 from (select h1.data as data, h1.actor_type as actor_type, h1.actor_id as actor_id, h1.created_at as created_at from changes h1 where h1.entity_type = 'task' and h1.entity_id = ${tasks.id} and h1.verb is not null and h1.op = 'update'
    union all select h2.data, h2.actor_type, h2.actor_id, h2.created_at from activity h2 where h2.entity_type = 'task' and h2.entity_id = ${tasks.id}) h where ${c})`;
}

function statusValue(path: "to" | "from", v: string, org: string): SQL {
  const l = v.toLowerCase();
  if (path === "to") {
    if (l === "open") return sql`coalesce(json_extract(h.data, '$.status.category'), 'done') <> 'done'`;
    if (l === "todo" || l === "doing" || l === "done") return sql`json_extract(h.data, '$.status.category') = ${l}`;
    return sql`lower(json_extract(h.data, '$.status.name')) = ${l}`;
  }
  if (l === "open") return sql`json_extract(h.data, '$.status.from') in (select s.id from project_statuses s where s.org_id = ${org} and s.category <> 'done')`;
  if (l === "todo" || l === "doing" || l === "done") return sql`json_extract(h.data, '$.status.from') in (select s.id from project_statuses s where s.org_id = ${org} and s.category = ${l})`;
  return sql`json_extract(h.data, '$.status.from') in (select s.id from project_statuses s where s.org_id = ${org} and lower(s.name) = ${l})`;
}

function personValue(v: string, ctx: TaskQueryCtx): SQL {
  const l = v.toLowerCase();
  const org = ctx.actor.orgId;
  if (l === "none") return sql`json_type(h.data, '$.assignee') = 'null'`;
  if (l === "me") return sql`json_extract(h.data, '$.assignee') = ${ctx.actor.agentId ? `agent:${ctx.actor.agentId}` : `member:${ctx.actor.userId}`}`;
  return sql`json_extract(h.data, '$.assignee') in (select 'member:' || u.id from users u join members m on m.user_id = u.id where m.organization_id = ${org} and (lower(u.email) = ${l} or lower(u.name) = ${l} or lower(u.name) like ${`${l} %`}) union all select 'agent:' || a.id from agents a where a.org_id = ${org} and lower(a.name) = ${l})`;
}

function actorValue(v: string, ctx: TaskQueryCtx): SQL {
  const l = v.toLowerCase();
  if (l === "me") return ctx.actor.agentId ? sql`(h.actor_type = 'agent' and h.actor_id = ${ctx.actor.agentId})` : sql`(h.actor_type = 'member' and h.actor_id = ${ctx.actor.userId})`;
  return sql`h.actor_id in (select u.id from users u join members m on m.user_id = u.id where m.organization_id = ${ctx.actor.orgId} and (lower(u.email) = ${l} or lower(u.name) = ${l} or lower(u.name) like ${`${l} %`}) union all select a.id from agents a where a.org_id = ${ctx.actor.orgId} and lower(a.name) = ${l})`;
}

/** The new value a change row set, for a history key. */
function toValue(key: HistoryTerm["key"], v: string, ctx: TaskQueryCtx): SQL {
  if (key === "status") return statusValue("to", v, ctx.actor.orgId);
  if (key === "assignee") return personValue(v, ctx);
  return sql`json_extract(h.data, '$.priority') = ${v.toLowerCase()}`;
}

function historyCond(t: HistoryTerm, ctx: TaskQueryCtx): SQL {
  const now = ctx.deps.now();
  const any = (list: SQL[]) => (list.length === 1 ? list[0] : sql`(${sql.join(list, sql` or `)})`);
  if (t.op === "was") {
    // WAS: the value now, or any change that set it, or (status) any change that left it.
    const current = termCond({ kind: "field", key: t.key, op: "=", values: t.values, negate: false, pos: t.pos }, ctx);
    const past = t.values.map((v) => (t.key === "status" ? sql`(${toValue(t.key, v, ctx)} or ${statusValue("from", v, ctx.actor.orgId)})` : toValue(t.key, v, ctx)));
    return sql`(${current} or ${historyRows(any(past))})`;
  }
  const parts: SQL[] = [sql`json_type(h.data, ${`$.${t.key}`}) is not null`];
  if (t.from?.length) parts.push(any(t.from.map((v) => statusValue("from", v, ctx.actor.orgId))));
  if (t.to?.length) parts.push(any(t.to.map((v) => toValue(t.key, v, ctx))));
  if (t.after) { const r = dateRange(t.after, now, true); parts.push(sql`h.created_at >= ${r.from.getTime()}`); }
  if (t.before) { const r = dateRange(t.before, now, true); parts.push(sql`h.created_at < ${r.from.getTime()}`); }
  if (t.by) parts.push(actorValue(t.by, ctx));
  return historyRows(sql.join(parts, sql` and `));
}

function termCond(t: QueryTerm, ctx: TaskQueryCtx): SQL {
  const org = ctx.actor.orgId;
  const now = ctx.deps.now();
  // R34: a plain ref (OPS-12) also finds the task by an old key or the ref it had before a move.
  if (t.kind === "text") return TASK_REF_RE.test(t.value) ? sql`(${textCond(t.value)} or ${refCond(org, t.value)})` : textCond(t.value);
  if (t.kind === "history") return historyCond(t, ctx);
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
    case "label": return each((v) => containsText(tasks.labels, JSON.stringify(v.toLowerCase())));
    case "priority": return each((v) => (t.op === "=" ? eq(tasks.priority, v.toLowerCase() as "none") : compare(PRIORITY_SQL, t.op, PRIORITY_RANK[v.toLowerCase()])));
    case "type": return each((v) => eq(tasks.type, v.toLowerCase() as "task"));
    case "due": return each((v) => (v.toLowerCase() === "none" ? isNull(tasks.dueAt) : dateCond(tasks.dueAt, t.op, v, now, false)));
    case "created": return each((v) => dateCond(tasks.createdAt, t.op, v, now, true));
    case "updated": return each((v) => dateCond(tasks.updatedAt, t.op, v, now, true));
    case "points": return each((v) => (v.toLowerCase() === "none" ? isNull(tasks.points) : compare(tasks.points, t.op, Number(v))));
    // R34: a key the project used before a key edit matches too (project:OPS after OPS became OPR).
    case "project": return each((v) => sql`${tasks.projectId} in (select p.id from projects p where p.org_id = ${org} and p.deleted_at is null and (upper(p.key) = ${v.toUpperCase()} or lower(p.name) = ${v.toLowerCase()}) union all select ka.project_id from project_key_aliases ka where ka.org_id = ${org} and ka.key = ${v.toUpperCase()})`);
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
        // R27: tasks I watch (a key-lookup on task_watchers' primary key). Agents watch nothing.
        case "watching": return ctx.actor.agentId || !ctx.actor.userId ? sql`0` : sql`exists (select 1 from task_watchers w where w.task_id = ${tasks.id} and w.user_id = ${ctx.actor.userId})`;
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
  // R34: OR, AND, NOT and brackets compile to one condition; a flat list keeps the R26 shape (one condition per term).
  if (parsed.tree) return [nodeCond(parsed.tree, ctx)];
  return parsed.terms.map((t) => leaf(t, ctx));
}

const leaf = (t: QueryTerm, ctx: TaskQueryCtx): SQL => {
  const c = termCond(t, ctx);
  return t.negate ? sql`coalesce((${c}), 0) = 0` : c;
};

function nodeCond(n: QueryNode, ctx: TaskQueryCtx): SQL {
  switch (n.op) {
    case "term": return leaf(n.term, ctx);
    case "not": return sql`coalesce((${nodeCond(n.item, ctx)}), 0) = 0`;
    case "and": return sql`(${sql.join(n.items.map((x) => nodeCond(x, ctx)), sql` and `)})`;
    case "or": return sql`(${sql.join(n.items.map((x) => nodeCond(x, ctx)), sql` or `)})`;
  }
}

