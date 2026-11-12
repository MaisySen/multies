import { inArray, or, getTableColumns, getTableName, type SQL } from "drizzle-orm";
import type { SQLiteTable, SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as s from "@/server/db/schema";
import type { privacyWorld } from "./priv1a-world";

/**
 * PRIV1b (F24, F25, F26, F27): what the route and MCP walks need to reach the mailbox rule, not the validator.
 * `sample` fills a JSON schema (an MCP tool's input schema, or a route's zod schema through z.toJSONSchema) with a value
 * that passes it, putting Pat's ids wherever a field names a mailbox, thread, message, attachment, draft or connection.
 * `patState` reads every row that belongs to Pat's personal mail, so a walker's write shows up whatever the route answered.
 */
export type W = Awaited<ReturnType<typeof privacyWorld>>;
export interface Ids { mailbox: string; thread: string; message: string; attachment: string; draft: string; connection: string; user: string; address: string; label?: string }

const FUTURE = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
type JS = { type?: string | string[]; properties?: Record<string, JS>; required?: string[]; items?: JS; anyOf?: JS[]; oneOf?: JS[]; allOf?: JS[]; enum?: unknown[]; const?: unknown;
  format?: string; minimum?: number; exclusiveMinimum?: number; minItems?: number; minLength?: number; maxLength?: number; pattern?: string; default?: unknown };

/** The id a field named `key` takes. */
export function idFor(key: string, ids: Ids): string | null {
  const k = key.toLowerCase().replace(/s$/, "");
  if (/mailboxid|frommailbox/.test(k)) return ids.mailbox;
  if (/threadid/.test(k)) return ids.thread;
  if (/attachmentid|fileid/.test(k)) return ids.attachment;
  if (/draftid/.test(k)) return ids.draft;
  if (/connectionid/.test(k)) return ids.connection;
  if (/userid|assignee|memberid|delegateid/.test(k)) return ids.user;
  if (/messageid|inreplytoid|replytoid|forwardid|sourceid|^id$|^ids?$/.test(k)) return ids.message;
  return null;
}

export function sample(schema: JS | undefined, key: string, ids: Ids, depth = 0): unknown {
  if (!schema || depth > 6) return "walk";
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum.find((e) => e !== null) ?? schema.enum[0];
  const branch = schema.anyOf ?? schema.oneOf;
  if (branch?.length) return sample(branch.find((b) => b.type !== "null") ?? branch[0], key, ids, depth + 1);
  if (schema.allOf?.length) return Object.assign({}, ...schema.allOf.map((b) => sample(b, key, ids, depth + 1) as object));
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type ?? (schema.properties ? "object" : schema.items ? "array" : "string");
  if (type === "object") {
    const out: Record<string, unknown> = {};
    // Optional fields only when they name one of Pat's ids: an optional field with a pattern would fail the whole body.
    for (const [k, v] of Object.entries(schema.properties ?? {})) if (schema.required?.includes(k) || idFor(k, ids)) out[k] = sample(v, k, ids, depth + 1);
    return out;
  }
  if (type === "array") return Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () => sample(schema.items, key, ids, depth + 1));
  if (type === "number" || type === "integer") return Math.max(1, Math.ceil(schema.minimum ?? (schema.exclusiveMinimum ?? 0) + 1));
  if (type === "boolean") return true;
  const id = idFor(key, ids);
  if (id) return id;
  const k = key.toLowerCase();
  if (schema.format === "email" || /email|address|^to$|^cc$|^bcc$|replyto|recipient/.test(k)) return "walk@example.com";
  if (schema.format === "date-time" || /(^|_)(at|until|date|when|time)$|at$|until$|^sendat|^remindat|^snooze/.test(k)) return FUTURE();
  if (schema.format === "date") return FUTURE().slice(0, 10);
  if (schema.format === "uri" || /url$/.test(k)) return "https://example.com/walk";
  const v = schema.minLength && schema.minLength > 4 ? "walk".padEnd(schema.minLength, "k") : "walk";
  if (!schema.pattern) return v;
  const re = new RegExp(schema.pattern);
  return [v, `f:${v}`, "walk_walk01", "walk-walk-01", "a", "1", "#ff5a36", "en"].find((x) => re.test(x)) ?? v;
}

/** A body most mail routes accept: every common field, with Pat's ids. Zod objects drop the fields they don't know. */
export function richBody(ids: Ids) {
  return {
    mailboxId: ids.mailbox, fromMailboxId: ids.mailbox, messageId: ids.message, messageIds: [ids.message], ids: [ids.message], id: ids.message,
    threadId: ids.thread, threadIds: [ids.thread], attachmentId: ids.attachment, attachmentIds: [ids.attachment], inReplyToId: ids.message, draftId: ids.draft,
    connectionId: ids.connection, userId: ids.user, to: ["walk@example.com"], subject: "walk", text: "walk", body: "walk", html: "<p>walk</p>", name: "walk", title: "walk",
    label: "walk", labels: ["walk"], displayName: "walk", replyTo: "walk@example.com", level: "read", folder: "archive", query: "walk", q: "walk",
    until: FUTURE(), at: FUTURE(), sendAt: FUTURE(), remindAt: FUTURE(), isStarred: true, starred: true, action: "trash", status: "done",
    client_job_id: "walkjob0001", scope: { mailboxId: ids.mailbox }, max_received_at: FUTURE(), from: ids.address, supabaseUrl: "https://walk.example.com",
  };
}

/** Tables whose rows hang off a mailbox, thread, message, attachment or connection id. Logs of who opened what are left out. */
const OWNED: [SQLiteTable, string[]][] = [
  [s.mailboxes, ["id"]], [s.messages, ["id", "mailboxId", "threadId"]], [s.attachments, ["id", "messageId"]], [s.mailboxAccess, ["mailboxId"]],
  [s.mailboxDelegations, ["mailboxId"]], [s.mailServerAccounts, ["mailboxId"]], [s.agentMailboxAccess, ["mailboxId"]], [s.sendApprovals, ["mailboxId", "threadId", "messageId"]],
  [s.importJobs, ["mailboxId"]], [s.mailConnections, ["id", "mailboxId"]], [s.mailSyncOutbox, ["connectionId", "messageId"]], [s.tasks, ["threadId", "messageId"]],
  [s.mailSchedules, ["mailboxId", "threadId", "messageId"]], [s.threadComments, ["threadId", "mailboxId"]], [s.mailThreadState, ["threadId", "mailboxId"]],
  [s.mailRules, ["mailboxId"]], [s.mailThreadLabels, ["threadId", "mailboxId"]], [s.signRequests, ["mailboxId"]], [s.hdTickets, ["mailboxId"]],
  [s.crmSuggestionsTd10, ["mailboxId", "messageId"]], [s.agents, ["mailboxId"]], [s.authEmailHooks, ["mailboxId"]], [s.meetings, ["mailboxId"]],
];

/** Every row of Pat's personal mail, as one string per table. `isRead` is left out when `readOk` (a read share marks mail read by design). */
export async function patState(w: W, pat: { mailboxes: string[]; threads: string[]; messages: string[]; attachments: string[]; connections: string[] }, readOk = false) {
  const out: Record<string, string> = {};
  const byCol: Record<string, string[]> = { mailboxId: pat.mailboxes, threadId: pat.threads, messageId: pat.messages, connectionId: pat.connections };
  const byId = new Map<SQLiteTable, string[]>([[s.mailboxes, pat.mailboxes], [s.messages, pat.messages], [s.attachments, pat.attachments], [s.mailConnections, pat.connections]]);
  for (const [t, cols] of OWNED) {
    const all = getTableColumns(t) as Record<string, SQLiteColumn>;
    const conds: SQL[] = [];
    for (const c of cols) {
      const list = (c === "id" ? byId.get(t) : byCol[c]) ?? [];
      if (list.length) conds.push(inArray(all[c]!, list));
    }
    if (!conds.length) continue;
    const rows = await w.ctx.db.select().from(t).where(or(...conds)).all() as Record<string, unknown>[];
    out[getTableName(t)] = JSON.stringify(rows.map((r) => {
      const { updatedAt: _u, usedBytes: _b, lastUsedAt: _l, ...rest } = r;
      if (readOk) delete rest.isRead;
      return rest;
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  return out;
}

/** The tables whose rows changed between two patState reads. */
export const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

/** Ids and times differ between two calls; what is left is the data. */
export const norm = (text: string, ...ids: string[]) => {
  let t = text;
  for (const id of ids) t = t.split(id).join("<ID>");
  return t.replace(/\b[a-z]{2,6}_[a-z0-9]{8,}\b/g, "<id>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>").replace(/\b1[6-9]\d{11}\b/g, "<t>").replace(/"tookMs":\d+/g, "");
};
