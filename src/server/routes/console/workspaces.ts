/**
 * OPS1: /api/console/workspaces, Workspaces. Mounted by routes/console/index.ts.
 *
 * Reads (workspaces.read):
 *   GET  /                          list: ?q (name, id, slug, owner email, domain) &plan &state (suspended, pastDue,
 *                                   comp, demo, active) or &suspended &pastDue &comp &demo (true/false) &sort &cursor &limit
 *   GET  /notes                     ?targetType=workspace|user&targetId=  notes, pinned first (also used by Users)
 *   GET  /:id                       state, limits, usage, counts and today's write budget
 *   GET  /:id/members               ?q &kind=human|agent &sort=createdAt|email|name
 *   GET  /:id/usage                 ?days=1..90
 *   GET  /:id/mail                  domains and mailboxes
 *   GET  /:id/agents                agent inboxes and agent members
 *   GET  /:id/developer             API keys (no secrets), webhook endpoints (masked), OAuth grants
 *   GET  /:id/audit                 ?source=workspace (its own activity, default) | platform (operator actions on it,
 *                                   with target names from withAuditNames)
 *   GET  /:id/queued-sends          messages a sending limit held
 * Changes (every one takes a reason and is audited on the platform log and, except notes, the workspace's own log):
 *   POST /:id/suspend               workspaces.suspend   workspace.suspended
 *   POST /:id/unsuspend             workspaces.suspend   workspace.unsuspended
 *   PUT  /:id/send-cap              workspaces.limits    workspace.send_cap_changed     { cap: number | null }
 *   PUT  /:id/sending               workspaces.limits    workspace.sending_on|off       { enabled }
 *   PUT  /:id/meeting-cap           workspaces.limits    workspace.meeting_cap_changed  { cap: number | null }
 *   POST /:id/queued-sends/:sid/send workspaces.limits   message.queued_send_forced
 *   POST /notes                     workspaces.notes     note.added     { targetType, targetId, body, pinned? }
 *   POST /notes/:noteId/pin         workspaces.notes     note.pinned | note.unpinned  { pinned }
 *   DELETE /notes/:noteId           workspaces.notes     note.deleted (the author or an owner)
 * Notes are staff only: their audit rows never carry the text and never go to the workspace's own log. Adding and
 * pinning take an optional reason (the note itself is the record); deleting needs one.
 *
 * The data layer pages with { limit, cursor: { v, id }, sort: { field, dir } } -> { items, next }; this file turns that
 * into the console's ?cursor=&sort=field:dir and { items, nextCursor } (the cursor is base64url JSON).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { parseBody } from "../../middleware";
import { HttpError, notFound } from "../../lib/errors";
import { operatorSession, requireOperator } from "../../auth/operator";
import { listPlatformAudit, operatorAction, reasonSchema, withAuditNames } from "../../services/console/audit";
import {
  getWorkspaceOverview, getWorkspaceUsage, listWorkspaceAgents, listWorkspaceAudit, listWorkspaceDeveloper, listWorkspaceDomainsAndMailboxes,
  listWorkspaceMembers, listWorkspaces, setWorkspaceMeetingCap, setWorkspaceSendCap, type WorkspaceFilters,
} from "../../services/console/workspaces";
import { addNote, deleteNote, getNote, listNotes, setNotePinned, type NoteTargetType } from "../../services/console/notes";
import { suspendWorkspace, unsuspendWorkspace } from "../../services/console/moderation";
import { forceQueuedSend, listQueuedSendsAll, setWorkspaceSending } from "../../services/console/mail";
import { getOrg } from "../../services/plans";
import { isPlanId } from "@/shared/plans";

// ---- paging glue -------------------------------------------------------------------------------------------------

interface Cursor { v: string | number; id: string }
type Dir = "asc" | "desc";

function encodeCursor(c: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 600) throw new Error("long");
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as Cursor;
    if (!v || typeof v.id !== "string" || !v.id || (typeof v.v !== "string" && typeof v.v !== "number")) throw new Error("shape");
    return { v: v.v, id: v.id };
  } catch {
    throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
  }
}

/** The data layer's page request from ?limit, ?cursor and ?sort=field:dir (the service checks the field). */
function pageOf(q: Record<string, string | undefined>, defaultSort: `${string}:${Dir}`) {
  const [field, dir] = (q.sort || defaultSort).split(":");
  if (dir !== undefined && dir !== "asc" && dir !== "desc") throw new HttpError(400, "bad_sort", "Sort direction is asc or desc.");
  const n = Number.parseInt(q.limit ?? "", 10);
  return {
    limit: Number.isFinite(n) && n > 0 ? n : 50,
    cursor: decodeCursor(q.cursor),
    sort: { field: field ?? "", dir: (dir ?? defaultSort.split(":")[1]) as Dir },
  };
}

// listNotes checks the field itself (400 bad_sort); the type only names the allowed one.
type NotesPage = Parameters<typeof listNotes>[1]["page"];

const answer = <T>(p: { items: T[]; next: Cursor | null }) => ({ items: p.items, nextCursor: p.next ? encodeCursor(p.next) : null });

const flag = (v: string | undefined): boolean | undefined => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined);

/** An id from the path: short and plain, else 404 (never a query with a strange value). */
function idParam(c: Context<AppEnv>, name = "id"): string {
  const id = c.req.param(name) ?? "";
  if (!id || id.length > 64 || !/^[\w-]+$/.test(id)) throw notFound(name === "id" ? "Workspace" : "Item");
  return id;
}

/** The workspace from the path, 404 when it does not exist. */
async function workspaceOf(c: Context<AppEnv>) {
  return getOrg(c.var.deps.db, idParam(c));
}

const capSchema = z.number().int().min(0).max(1_000_000).nullable();
const meetingCapSchema = z.number().int().min(0).max(10_000_000).nullable();
const targetTypeSchema = z.enum(["workspace", "user"]);

function noteSubject(targetType: NoteTargetType, targetId: string) {
  return { orgId: targetType === "workspace" ? targetId : null, metadata: { noteOn: targetType, noteOnId: targetId } };
}

export function workspacesRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .use("*", async (c, next) => { await next(); c.header("cache-control", "no-store"); })

    // ---- list ----------------------------------------------------------------------------------------------------
    .get("/", requireOperator("workspaces.read"), async (c) => {
      const q = c.req.query();
      const filters: WorkspaceFilters = {
        comp: flag(q.comp), suspended: flag(q.suspended), pastDue: flag(q.pastDue), demo: flag(q.demo),
      };
      if (q.plan) {
        if (!isPlanId(q.plan)) throw new HttpError(400, "bad_filter", "Pick a plan: starter, pro or business.");
        filters.plan = q.plan;
      }
      switch (q.state) {
        case undefined: case "": case "all": break;
        case "suspended": filters.suspended = true; break;
        case "pastDue": filters.pastDue = true; break;
        case "comp": filters.comp = true; break;
        case "demo": filters.demo = true; break;
        case "active": filters.suspended = false; filters.pastDue = false; break;
        default: throw new HttpError(400, "bad_filter", "Pick a state: suspended, past due, comp, demo or active.");
      }
      return c.json(answer(await listWorkspaces(c.var.deps, { q: q.q, filters, page: pageOf(q, "createdAt:desc") })));
    })

    // ---- notes (before /:id so "notes" is never read as a workspace id) -------------------------------------------
    .get("/notes", requireOperator("workspaces.read"), async (c) => {
      const q = c.req.query();
      const t = targetTypeSchema.safeParse(q.targetType);
      if (!t.success) throw new HttpError(400, "bad_filter", "Notes are on a workspace or a person.");
      return c.json(answer(await listNotes(c.var.deps, { targetType: t.data, targetId: q.targetId ?? "", page: pageOf(q, "createdAt:desc") as NotesPage })));
    })
    .post("/notes", requireOperator("workspaces.notes"), async (c) => {
      const body = await parseBody(c, z.object({
        targetType: targetTypeSchema, targetId: z.string().trim().min(1).max(64), body: z.string().max(10_000),
        pinned: z.boolean().optional(), reason: reasonSchema.optional(),
      }));
      const { auth } = c.var;
      const subject = noteSubject(body.targetType, body.targetId);
      type R = Awaited<ReturnType<typeof addNote>>;
      const r = await operatorAction(c, {
        action: "note.added", targetType: "note", targetId: (x: R) => x.note.id, reason: body.reason ?? null, ...subject,
        before: null, after: (x: R) => x.after,
      }, () => addNote(c.var.deps, { targetType: body.targetType, targetId: body.targetId, body: body.body, pinned: body.pinned, author: { userId: auth.userId, email: auth.email } }));
      return c.json({ note: r.note }, 201);
    })
    .post("/notes/:noteId/pin", requireOperator("workspaces.notes"), async (c) => {
      const body = await parseBody(c, z.object({ pinned: z.boolean(), reason: reasonSchema.optional() }));
      const id = idParam(c, "noteId");
      const note = await getNote(c.var.deps, id);
      if (!note || note.deletedAt) throw notFound("Note");
      type R = Awaited<ReturnType<typeof setNotePinned>>;
      const r = await operatorAction(c, {
        action: body.pinned ? "note.pinned" : "note.unpinned", targetType: "note", targetId: id, reason: body.reason ?? null,
        ...noteSubject(note.targetType, note.targetId), before: (x: R) => x.before, after: (x: R) => x.after,
      }, () => setNotePinned(c.var.deps, id, body.pinned));
      return c.json({ note: r.note });
    })
    .delete("/notes/:noteId", requireOperator("workspaces.notes"), async (c) => {
      const body = await parseBody(c, z.object({ reason: reasonSchema }));
      const id = idParam(c, "noteId");
      const note = await getNote(c.var.deps, id);
      if (!note || note.deletedAt) throw notFound("Note");
      if (note.authorUserId !== c.var.auth.userId && c.var.operator?.role !== "admin") {
        throw new HttpError(403, "not_author", "Only the person who wrote this note or an owner can delete it.");
      }
      type R = Awaited<ReturnType<typeof deleteNote>>;
      await operatorAction(c, {
        action: "note.deleted", targetType: "note", targetId: id, reason: body.reason,
        ...noteSubject(note.targetType, note.targetId), before: (x: R) => x.before, after: (x: R) => x.after,
      }, () => deleteNote(c.var.deps, id));
      return c.json({ ok: true });
    })

    // ---- one workspace -------------------------------------------------------------------------------------------
    .get("/:id", requireOperator("workspaces.read"), async (c) => c.json(await getWorkspaceOverview(c.var.deps, idParam(c))))
    .get("/:id/members", requireOperator("workspaces.read"), async (c) => {
      const org = await workspaceOf(c);
      const q = c.req.query();
      const kind = q.kind === "human" || q.kind === "agent" ? q.kind : undefined;
      return c.json(answer(await listWorkspaceMembers(c.var.deps, org.id, { q: q.q, kind, page: pageOf(q, "createdAt:asc") })));
    })
    .get("/:id/usage", requireOperator("workspaces.read"), async (c) => {
      const days = Number.parseInt(c.req.query("days") ?? "30", 10);
      return c.json(await getWorkspaceUsage(c.var.deps, idParam(c), { days: Number.isFinite(days) ? days : 30 }));
    })
    .get("/:id/mail", requireOperator("workspaces.read"), async (c) => {
      const org = await workspaceOf(c);
      return c.json(await listWorkspaceDomainsAndMailboxes(c.var.deps, org.id));
    })
    .get("/:id/agents", requireOperator("workspaces.read"), async (c) => {
      const org = await workspaceOf(c);
      return c.json(await listWorkspaceAgents(c.var.deps, org.id));
    })
    .get("/:id/developer", requireOperator("workspaces.read"), async (c) => {
      const org = await workspaceOf(c);
      return c.json(await listWorkspaceDeveloper(c.var.deps, org.id));
    })
    .get("/:id/audit", requireOperator("workspaces.read"), async (c) => {
      const org = await workspaceOf(c);
      const q = c.req.query();
      const source = q.source || "workspace";
      if (source === "platform") {
        const r = await listPlatformAudit(c.var.deps.db, { q: q.q, limit: q.limit, cursor: q.cursor, sort: q.sort }, { orgId: org.id });
        // Target names for the page in two batched reads at most (never one per row), as the global audit log does.
        const named = await withAuditNames(c.var.deps.db, r.items);
        return c.json({
          nextCursor: r.nextCursor,
          items: named.map((x) => ({
            id: x.id, source: "platform" as const, action: x.action, actorUserId: x.actorUserId, actorEmail: x.actorEmail, actorRole: x.actorRole,
            targetType: x.targetType, targetId: x.targetId, targetLabel: x.targetLabel, reason: x.reason, before: x.before, after: x.after, metadata: x.metadata, createdAt: new Date(x.createdAt).toISOString(),
          })),
        });
      }
      if (source !== "workspace") throw new HttpError(400, "bad_filter", "Show workspace activity or operator actions.");
      const actor = q.q?.trim().slice(0, 100) || undefined;
      const r = await listWorkspaceAudit(c.var.deps, org.id, { filter: actor ? { actor } : undefined, page: pageOf(q, "createdAt:desc") });
      return c.json(answer({
        next: r.next,
        items: r.items.map((x) => ({
          id: x.id, source: "workspace" as const, action: x.action, actorUserId: x.actorUserId, actorEmail: x.actorEmail, actorRole: null,
          targetType: x.targetType, targetId: x.targetId, targetLabel: null, reason: typeof x.metadata?.reason === "string" ? x.metadata.reason : null, before: null, after: null,
          metadata: x.metadata, createdAt: x.createdAt,
        })),
      }));
    })
    .get("/:id/queued-sends", requireOperator("workspaces.read"), async (c) => {
      const org = await workspaceOf(c);
      const r = await listQueuedSendsAll(c.var.deps, { orgId: org.id }, pageOf(c.req.query(), "dueAt:asc"));
      return c.json(answer({ next: r.next, items: r.items.map((x) => ({ ...x, dueAt: x.dueAt.toISOString(), createdAt: x.createdAt.toISOString() })) }));
    })

    // ---- changes -------------------------------------------------------------------------------------------------
    .post("/:id/suspend", requireOperator("workspaces.suspend"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const id = idParam(c);
      type R = Awaited<ReturnType<typeof suspendWorkspace>>;
      const r = await operatorAction(c, {
        action: "workspace.suspended", targetType: "workspace", targetId: id, orgId: id, reason,
        before: (x: R) => x.before, after: (x: R) => x.after, workspaceAudit: true,
      }, () => suspendWorkspace(c.var.deps, id, reason));
      return c.json({ ok: true, suspendedAt: r.after.suspendedAt });
    })
    .post("/:id/unsuspend", requireOperator("workspaces.suspend"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const id = idParam(c);
      type R = Awaited<ReturnType<typeof unsuspendWorkspace>>;
      const r = await operatorAction(c, {
        action: "workspace.unsuspended", targetType: "workspace", targetId: id, orgId: id, reason,
        before: (x: R) => x.before, after: (x: R) => ({ ...x.after, resolvedAbuseEvents: x.resolvedAbuseEvents }), workspaceAudit: true,
      }, () => unsuspendWorkspace(c.var.deps, id));
      return c.json({ ok: true, resolvedAbuseEvents: r.resolvedAbuseEvents });
    })
    .put("/:id/send-cap", requireOperator("workspaces.limits"), async (c) => {
      const { cap, reason } = await parseBody(c, z.object({ cap: capSchema, reason: reasonSchema }));
      const id = idParam(c);
      type R = Awaited<ReturnType<typeof setWorkspaceSendCap>>;
      await operatorAction(c, {
        action: "workspace.send_cap_changed", targetType: "workspace", targetId: id, orgId: id, reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { cap }, workspaceAudit: true,
      }, () => setWorkspaceSendCap(c.var.deps, id, cap));
      return c.json({ ok: true, sendCapDaily: cap });
    })
    .put("/:id/sending", requireOperator("workspaces.limits"), async (c) => {
      const { enabled, reason } = await parseBody(c, z.object({ enabled: z.boolean(), reason: reasonSchema }));
      const id = idParam(c);
      type R = Awaited<ReturnType<typeof setWorkspaceSending>>;
      const r = await operatorAction(c, {
        action: enabled ? "workspace.sending_on" : "workspace.sending_off", targetType: "workspace", targetId: id, orgId: id, reason,
        before: (x: R) => ({ cap: x.before.sendCapDaily }), after: (x: R) => ({ cap: x.sendCapDaily }), workspaceAudit: true,
      }, () => setWorkspaceSending(c.var.deps, id, enabled));
      return c.json({ ok: true, sending: r.sending, sendCapDaily: r.sendCapDaily });
    })
    .put("/:id/meeting-cap", requireOperator("workspaces.limits"), async (c) => {
      const { cap, reason } = await parseBody(c, z.object({ cap: meetingCapSchema, reason: reasonSchema }));
      const id = idParam(c);
      type R = Awaited<ReturnType<typeof setWorkspaceMeetingCap>>;
      await operatorAction(c, {
        action: "workspace.meeting_cap_changed", targetType: "workspace", targetId: id, orgId: id, reason,
        before: (x: R) => x.before, after: (x: R) => x.after, metadata: { cap }, workspaceAudit: true,
      }, () => setWorkspaceMeetingCap(c.var.deps, id, cap));
      return c.json({ ok: true, meetingMinutesCap: cap });
    })
    .post("/:id/queued-sends/:sid/send", requireOperator("workspaces.limits"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const org = await workspaceOf(c);
      const sid = idParam(c, "sid");
      const r = await operatorAction(c, {
        action: "message.queued_send_forced", targetType: "schedule", targetId: sid, orgId: org.id, reason,
        after: (x: { dueAt: string }) => ({ forced: true, dueAt: x.dueAt }), workspaceAudit: true,
      }, () => forceQueuedSend(c.var.deps, org.id, sid));
      return c.json(r);
    });
}
