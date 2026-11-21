/**
 * OPS1: /api/console/flags, Feature flags (Phase 4): the registry (src/shared/feature-flags.ts) with each flag's deploy
 * default, platform wide override (optionally locked) and per workspace overrides (services/console/flags.ts).
 *
 * GET    /api/console/flags                          { items, nextCursor } (flags.read)
 *          ?q= (label, description, key, env, group) &group=<registry group> &state=modified|changed|workspaces|deploy
 *          (modified: changed for everyone or with at least one workspace setting; changed: changed for everyone)
 *          &sort=group|label|workspaces:asc|desc (default group:asc; anything else is a 400) &limit= &cursor=
 * GET    /api/console/flags/workspaces/:orgId        { workspace, items, nextCursor }: every flag for one workspace with
 *          its value there and where it comes from (default, global, workspace, locked) (flags.read); 404 unknown workspace
 * GET    /api/console/flags/:key                     { flag, overrides: { items, nextCursor } }: one flag and the
 *          workspaces with their own setting, newest first, with workspace names (flags.read); 404 unknown flag
 * PUT    /api/console/flags/:key/global              { value, locked?, note?, reason }  flags.global, step up
 *          audit flags.global_set
 * DELETE /api/console/flags/:key/global              { reason }  flags.global, step up; audit flags.global_cleared
 * PUT    /api/console/flags/:key/workspaces/:orgId   { value, note?, reason }  flags.workspace; audit flags.workspace_set
 *          (also on the workspace's own audit log)
 * DELETE /api/console/flags/:key/workspaces/:orgId   { reason }  flags.workspace; audit flags.workspace_cleared
 *
 * The registry is small and lives in code, so lists page in memory: the cursor names the last flag (or workspace) of
 * the page. FlagError codes map to 404 (unknown flag), 409 (mailArchive off over an active legal hold) or 400 (set at deploy,
 * platform wide only, lock on a workspace).
 * Changes reach other servers within a minute (the overrides are kept 60 seconds per isolate).
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../../context";
import type { DB } from "../../db";
import { organizations, users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { inIds } from "../../lib/sql-chunks";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { decodeCursor, encodeCursor, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from "../../services/console/listing";
import {
  FlagError, GLOBAL_SCOPE, clearFlagOverride, effectiveFlags, listFlagsForConsole, listWorkspaceOverrides, loadFlagOverrides,
  setFlagOverride, type ConsoleFlagRow, type FlagOverride,
} from "../../services/console/flags";
import { FEATURE_FLAGS, flagDef, type FlagDef, type FlagGroup, type FlagKey } from "@/shared/feature-flags";

/** The registry's groups, in registry order. */
export const FLAG_GROUPS: FlagGroup[] = [...new Set((FEATURE_FLAGS as readonly FlagDef[]).map((d) => d.group))];

const SORT_FIELDS = ["group", "label", "workspaces"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const sortSchema = z.string().max(40).optional().transform((v, ctx) => {
  if (!v) return { field: "group" as SortField, dir: "asc" as const };
  const [f, d = "asc"] = v.split(":");
  if (!(SORT_FIELDS as readonly string[]).includes(f) || (d !== "asc" && d !== "desc")) {
    ctx.addIssue({ code: "custom", message: "Sort by group, label or workspaces." });
    return z.NEVER;
  }
  return { field: f as SortField, dir: d as "asc" | "desc" };
});

const groupSchema = z.string().max(60).optional().transform((v, ctx) => {
  if (!v || v === "all") return undefined;
  if (!(FLAG_GROUPS as string[]).includes(v)) { ctx.addIssue({ code: "custom", message: "That group does not exist." }); return z.NEVER; }
  return v as FlagGroup;
});

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  group: groupSchema,
  state: z.enum(["all", "modified", "changed", "workspaces", "deploy"]).optional(),
  sort: sortSchema,
}).passthrough();

const WorkspaceQuery = z.object({
  q: z.string().max(200).optional(),
  group: groupSchema,
  state: z.enum(["all", "own", "differs"]).optional(),
}).passthrough();

const note = z.string().trim().max(300, "Keep the note under 300 characters.").optional();
const SetGlobalBody = z.object({ value: z.boolean({ error: "Choose on or off." }), locked: z.boolean().optional(), note, reason: reasonSchema });
const SetWorkspaceBody = z.object({ value: z.boolean({ error: "Choose on or off." }), note, reason: reasonSchema });
const ReasonBody = z.object({ reason: reasonSchema });

/** Pages an in-memory list: limit (default 50, max 200) and a cursor naming the last item of the previous page. */
function pageOf<T>(rows: T[], idOf: (r: T) => string, query: Record<string, string | undefined>): { items: T[]; nextCursor: string | null } {
  const raw = Number.parseInt(query.limit ?? "", 10);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, LIST_MAX_LIMIT) : LIST_DEFAULT_LIMIT;
  let start = 0;
  if (query.cursor) {
    const { id } = decodeCursor(query.cursor);
    const at = rows.findIndex((r) => idOf(r) === id);
    if (at < 0) throw new HttpError(400, "bad_cursor", "That page link is out of date. Start the list again.");
    start = at + 1;
  }
  const items = rows.slice(start, start + limit);
  const last = items[items.length - 1];
  return { items, nextCursor: start + limit < rows.length && last ? encodeCursor(0, idOf(last)) : null };
}

const matches = (q: string, ...fields: (string | null | undefined)[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || fields.some((f) => (f ?? "").toLowerCase().includes(needle));
};

/** A FlagError as an HTTP error with its plain message: unknown flag is 404, the rest 400. */
function asHttp(e: unknown): never {
  if (e instanceof FlagError) throw new HttpError(e.code === "unknown_flag" ? 404 : e.code === "legal_hold_active" ? 409 : 400, e.code, e.message);
  throw e;
}

function mustFlag(key: string): FlagDef {
  const def = flagDef(key);
  if (!def) throw new HttpError(404, "unknown_flag", "There is no feature flag with that name.");
  return def;
}

async function workspaceOf(db: DB, orgId: string): Promise<{ id: string; name: string } | null> {
  if (!orgId || orgId.length > 100) return null;
  const [w] = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return w ?? null;
}

async function mustWorkspace(db: DB, orgId: string) {
  const w = await workspaceOf(db, orgId);
  if (!w) throw new HttpError(404, "not_found", "That workspace does not exist.");
  return w;
}

async function namesOf(db: DB, orgIds: string[]): Promise<Map<string, string>> {
  if (!orgIds.length) return new Map();
  const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inIds(organizations.id, orgIds));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function emailsOf(db: DB, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((v): v is string => !!v))];
  if (!list.length) return new Map();
  const rows = await db.select({ id: users.id, email: users.email }).from(users).where(inIds(users.id, list));
  return new Map(rows.map((r) => [r.id, r.email]));
}

/** What an override looks like in the audit log (the value, lock and note; no ids beyond the target). */
const auditShape = (o: FlagOverride | null) => (o ? { value: o.value ? "on" : "off", locked: o.locked, note: o.note } : null);

export type FlagSource = "default" | "global" | "workspace" | "locked";

function sortRows(rows: ConsoleFlagRow[], field: SortField, dir: "asc" | "desc"): ConsoleFlagRow[] {
  const order = new Map<string, number>(FLAG_GROUPS.map((g, i) => [g, i]));
  const registry = new Map<string, number>((FEATURE_FLAGS as readonly FlagDef[]).map((d, i) => [d.key, i]));
  const cmp = (a: ConsoleFlagRow, b: ConsoleFlagRow): number => {
    if (field === "group") return (order.get(a.group)! - order.get(b.group)!) || (registry.get(a.key)! - registry.get(b.key)!);
    if (field === "label") return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
    return (a.workspaceOverrideCount - b.workspaceOverrideCount) || a.label.localeCompare(b.label);
  };
  return [...rows].sort((a, b) => (dir === "asc" ? cmp(a, b) : -cmp(a, b)));
}

const noStore = (c: Context<AppEnv>) => { c.header("cache-control", "no-store"); };

export function flagsRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/", requireOperator("flags.read"), async (c) => {
      noStore(c);
      const f = parseQuery(c, ListQuery);
      const deps = c.var.deps;
      await loadFlagOverrides(deps);
      let rows = await listFlagsForConsole(deps);
      rows = rows.filter((r) => matches(f.q ?? "", r.label, r.description, r.key, r.env, r.group)
        && (!f.group || r.group === f.group)
        && (f.state === "modified" ? !!r.globalOverride || r.workspaceOverrideCount > 0 : f.state === "changed" ? !!r.globalOverride : f.state === "workspaces" ? r.workspaceOverrideCount > 0 : f.state === "deploy" ? !r.runtime : true));
      const page = pageOf(sortRows(rows, f.sort.field, f.sort.dir), (r) => r.key, c.req.query());
      const emails = await emailsOf(deps.db, page.items.map((r) => r.globalOverride?.updatedBy ?? null));
      return c.json({
        nextCursor: page.nextCursor,
        items: page.items.map((r) => ({ ...r, globalOverride: r.globalOverride ? { ...r.globalOverride, updatedByEmail: emails.get(r.globalOverride.updatedBy ?? "") ?? null } : null })),
      });
    })
    .get("/workspaces/:orgId", requireOperator("flags.read"), async (c) => {
      noStore(c);
      const f = parseQuery(c, WorkspaceQuery);
      const deps = c.var.deps;
      const workspace = await mustWorkspace(deps.db, c.req.param("orgId"));
      await loadFlagOverrides(deps);
      const flags = await listFlagsForConsole(deps);
      const own = new Map((await listWorkspaceOverrides(deps, { orgId: workspace.id })).map((o) => [o.key, o]));
      const values = effectiveFlags(deps, workspace.id);
      const rows = flags.map((r) => {
        const o = own.get(r.key) ?? null;
        const locked = !!r.globalOverride?.locked;
        // A row stored before a flag became platform wide, or under a lock, is kept but has no effect.
        const ownApplies = !!o && r.runtime && r.scope === "workspace" && !locked;
        const source: FlagSource = !r.runtime ? "default" : locked ? "locked" : ownApplies ? "workspace" : r.globalOverride ? "global" : "default";
        const blocked = !r.runtime ? "deploy" : r.scope === "global" ? "global_only" : locked ? "locked" : null;
        return {
          key: r.key, label: r.label, description: r.description, group: r.group, scope: r.scope, runtime: r.runtime,
          bootReason: r.bootReason, envDefault: r.envDefault,
          global: r.globalOverride ? { value: r.globalOverride.value, locked: r.globalOverride.locked } : null,
          platformValue: r.effective,
          workspaceOverride: o ? { value: o.value, note: o.note, updatedAt: o.updatedAt, applies: ownApplies } : null,
          effective: values[r.key as FlagKey],
          source,
          blocked,
        };
      }).filter((r) => matches(f.q ?? "", r.label, r.description, r.key, r.group)
        && (!f.group || r.group === f.group)
        && (f.state === "own" ? !!r.workspaceOverride : f.state === "differs" ? r.effective !== r.platformValue : true));
      return c.json({ workspace, ...pageOf(rows, (r) => r.key, c.req.query()) });
    })
    .get("/:key", requireOperator("flags.read"), async (c) => {
      noStore(c);
      const def = mustFlag(c.req.param("key"));
      const deps = c.var.deps;
      await loadFlagOverrides(deps);
      const flag = (await listFlagsForConsole(deps)).find((r) => r.key === def.key)!;
      const all = await listWorkspaceOverrides(deps, { key: def.key }).catch(asHttp);
      const page = pageOf(all, (o) => o.scopeId, c.req.query());
      const [names, emails] = await Promise.all([
        namesOf(deps.db, page.items.map((o) => o.scopeId)),
        emailsOf(deps.db, [flag.globalOverride?.updatedBy ?? null, ...page.items.map((o) => o.updatedBy)]),
      ]);
      return c.json({
        flag: { ...flag, globalOverride: flag.globalOverride ? { ...flag.globalOverride, updatedByEmail: emails.get(flag.globalOverride.updatedBy ?? "") ?? null } : null },
        overrides: {
          nextCursor: page.nextCursor,
          items: page.items.map((o) => ({
            orgId: o.scopeId, workspaceName: names.get(o.scopeId) ?? null, value: o.value, note: o.note,
            updatedByEmail: o.updatedBy ? emails.get(o.updatedBy) ?? null : null, updatedAt: o.updatedAt,
            // Kept but without effect while the platform wide value is locked.
            applies: !flag.globalOverride?.locked,
          })),
        },
      });
    })
    .put("/:key/global", requireOperator("flags.global", { stepUp: true }), async (c) => {
      const body = await parseBody(c, SetGlobalBody);
      const def = mustFlag(c.req.param("key"));
      const deps = c.var.deps;
      type R = Awaited<ReturnType<typeof setFlagOverride>>;
      const r = await operatorAction(c, {
        action: "flags.global_set", targetType: "flag", targetId: def.key, reason: body.reason,
        before: (x: R) => auditShape(x.before), after: (x: R) => auditShape(x.after), metadata: { scope: "global" },
      }, () => setFlagOverride(deps, { key: def.key, scopeId: GLOBAL_SCOPE, value: body.value, locked: body.locked, note: body.note, updatedBy: c.var.auth.userId }).catch(asHttp));
      return c.json({ ok: true, override: { value: r.after.value, locked: r.after.locked } });
    })
    .delete("/:key/global", requireOperator("flags.global", { stepUp: true }), async (c) => {
      const body = await parseBody(c, ReasonBody);
      const def = mustFlag(c.req.param("key"));
      const deps = c.var.deps;
      type R = Awaited<ReturnType<typeof clearFlagOverride>>;
      await operatorAction(c, {
        action: "flags.global_cleared", targetType: "flag", targetId: def.key, reason: body.reason,
        before: (x: R) => auditShape(x.before), after: null, metadata: { scope: "global" },
      }, async () => {
        const out = await clearFlagOverride(deps, { key: def.key, scopeId: GLOBAL_SCOPE }).catch(asHttp);
        if (!out.before) throw new HttpError(404, "no_override", `${def.label} already uses the default from deploy settings.`);
        return out;
      });
      return c.json({ ok: true });
    })
    .put("/:key/workspaces/:orgId", requireOperator("flags.workspace"), async (c) => {
      const body = await parseBody(c, SetWorkspaceBody);
      const def = mustFlag(c.req.param("key"));
      const deps = c.var.deps;
      const w = await mustWorkspace(deps.db, c.req.param("orgId"));
      type R = Awaited<ReturnType<typeof setFlagOverride>>;
      const r = await operatorAction(c, {
        action: "flags.workspace_set", targetType: "flag", targetId: def.key, orgId: w.id, reason: body.reason,
        before: (x: R) => auditShape(x.before), after: (x: R) => auditShape(x.after), metadata: { scope: "workspace", label: def.label },
        workspaceAudit: true,
      }, () => setFlagOverride(deps, { key: def.key, scopeId: w.id, value: body.value, note: body.note, updatedBy: c.var.auth.userId }).catch(asHttp));
      return c.json({ ok: true, override: { value: r.after.value } });
    })
    .delete("/:key/workspaces/:orgId", requireOperator("flags.workspace"), async (c) => {
      const body = await parseBody(c, ReasonBody);
      const def = mustFlag(c.req.param("key"));
      const deps = c.var.deps;
      const orgId = c.req.param("orgId");
      const w = await workspaceOf(deps.db, orgId);
      type R = Awaited<ReturnType<typeof clearFlagOverride>>;
      await operatorAction(c, {
        action: "flags.workspace_cleared", targetType: "flag", targetId: def.key, orgId: w?.id ?? orgId, reason: body.reason,
        before: (x: R) => auditShape(x.before), after: null, metadata: { scope: "workspace", label: def.label },
        workspaceAudit: !!w,
      }, async () => {
        const out = await clearFlagOverride(deps, { key: def.key, scopeId: orgId }).catch(asHttp);
        // A row left from a workspace that no longer exists can still be removed; otherwise the workspace must exist.
        if (!out.before) throw new HttpError(404, w ? "no_override" : "not_found", w ? `This workspace already uses the default for ${def.label}.` : "That workspace does not exist.");
        return out;
      });
      return c.json({ ok: true });
    });
}
