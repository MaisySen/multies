/**
 * OPS1: runtime feature flags over the registry in src/shared/feature-flags.ts and the feature_flag_overrides table.
 *
 * Order for one flag: env default (the AppConfig value loadConfig produced, untouched) -> global override (scope_id
 * '') -> workspace override (scope_id = org id, workspace scoped flags only). A global row with locked = 1 is a kill
 * switch: workspace rows are ignored while it stands. Flags with runtime false ignore every row. With no rows,
 * every answer equals the env default, so behaviour is exactly as before.
 *
 * Reads: loadFlagOverrides selects the whole (small) table once and keeps it for 60 seconds per isolate (per
 * database handle, so tests with their own database do not share it). It never writes. featureOn and the other
 * evaluators are synchronous over that memo: call `await loadFlagOverrides(deps)` once per request (or cron pass)
 * before them. Without a loaded memo they answer the env default. Another isolate sees a change within 60 seconds.
 *
 * Writes: setFlagOverride and clearFlagOverride change one row, drop this isolate's memo, and return
 * { before, after } for the caller's platform audit row.
 */
import { and, eq } from "drizzle-orm";
import type { AppConfig } from "../../config";
import type { Deps } from "../../context";
import type { DB } from "../../db";
import { featureFlagOverrides } from "../../db/schema";
import { FEATURE_FLAGS, flagDef, type FlagDef, type FlagKey, type FlagScope } from "@/shared/feature-flags";

export type FlagDeps = Pick<Deps, "db" | "config" | "now">;

export const FLAG_MEMO_MS = 60_000;
export const GLOBAL_SCOPE = "";

export type FlagErrorCode = "unknown_flag" | "not_runtime" | "global_only" | "lock_global_only" | "bad_scope";

export class FlagError extends Error {
  constructor(readonly code: FlagErrorCode, message: string) {
    super(message);
    this.name = "FlagError";
  }
}

export interface FlagOverride {
  key: string;
  /** '' for the global row, else a workspace id. */
  scopeId: string;
  value: boolean;
  locked: boolean;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

interface Memo {
  at: number;
  /** The invalidation generation it was loaded in; a later invalidate makes it stale. */
  gen: number;
  global: Map<string, FlagOverride>;
  /** key -> org id -> row */
  workspace: Map<string, Map<string, FlagOverride>>;
  rows: FlagOverride[];
}

const memos = new WeakMap<DB, Memo>();
const inflight = new WeakMap<DB, { gen: number; p: Promise<Memo> }>();
let generation = 0;

const parseValue = (v: string) => ["on", "1", "true"].includes(v.trim().toLowerCase());

function toOverride(r: typeof featureFlagOverrides.$inferSelect): FlagOverride {
  return { key: r.key, scopeId: r.scopeId, value: parseValue(r.value), locked: !!r.locked, note: r.note ?? null, updatedBy: r.updatedBy ?? null, updatedAt: r.updatedAt };
}

function buildMemo(rows: FlagOverride[], at: number, gen: number): Memo {
  const global = new Map<string, FlagOverride>();
  const workspace = new Map<string, Map<string, FlagOverride>>();
  for (const r of rows) {
    if (r.scopeId === GLOBAL_SCOPE) { global.set(r.key, r); continue; }
    let m = workspace.get(r.key);
    if (!m) { m = new Map(); workspace.set(r.key, m); }
    m.set(r.scopeId, r);
  }
  return { at, gen, global, workspace, rows };
}

/** The loaded memo, whatever its age, unless an invalidate came after it. */
function currentMemo(db: DB): Memo | undefined {
  const m = memos.get(db);
  return m && m.gen === generation ? m : undefined;
}

/** Loads every override (one select), reusing this isolate's copy for 60 seconds. Never writes. */
export async function loadFlagOverrides(deps: FlagDeps): Promise<FlagOverride[]> {
  const now = deps.now().getTime();
  const memo = currentMemo(deps.db);
  if (memo && now >= memo.at && now - memo.at < FLAG_MEMO_MS) return memo.rows;
  let job = inflight.get(deps.db);
  if (!job || job.gen !== generation) {
    const gen = generation;
    const p = (async () => {
      const rows = (await deps.db.select().from(featureFlagOverrides)).map(toOverride);
      const next = buildMemo(rows, deps.now().getTime(), gen);
      // A write that landed while this select ran bumped the generation: keep the stale answer out of the memo.
      if (gen === generation) memos.set(deps.db, next);
      return next;
    })().finally(() => { if (inflight.get(deps.db)?.p === p) inflight.delete(deps.db); });
    job = { gen, p };
    inflight.set(deps.db, job);
  }
  return (await job.p).rows;
}

/** Drops the memo, so the next loadFlagOverrides reads the table again (every database this isolate holds). */
export function invalidateFlagOverrides(deps?: Pick<Deps, "db">): void {
  generation++;
  if (deps) { memos.delete(deps.db); inflight.delete(deps.db); }
}

function readPath(config: AppConfig, path: string): unknown {
  let v: unknown = config;
  for (const part of path.split(".")) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function mustDef(key: string): FlagDef {
  const def = flagDef(key);
  if (!def) throw new FlagError("unknown_flag", `There is no feature flag called "${key}".`);
  return def;
}

/** The value the deployment's environment gives the flag (today's behaviour). */
export function envDefault(config: AppConfig, key: FlagKey): boolean {
  const def = mustDef(key);
  const v = readPath(config, def.configPath);
  return def.onWhenUnset ? v !== false : !!v;
}

function evaluate(def: FlagDef, config: AppConfig, memo: Memo | undefined, orgId?: string | null): boolean {
  const base = def.onWhenUnset ? readPath(config, def.configPath) !== false : !!readPath(config, def.configPath);
  if (!def.runtime || !memo) return base;
  const g = memo.global.get(def.key);
  let value = g ? g.value : base;
  if (orgId && def.scope === "workspace" && !g?.locked) {
    const w = memo.workspace.get(def.key)?.get(orgId);
    if (w) value = w.value;
  }
  return value;
}

/** Whether a flag is on, for one workspace when orgId is given. Synchronous over the loaded memo. */
export function featureOn(deps: FlagDeps, key: FlagKey, orgId?: string | null): boolean {
  return evaluate(mustDef(key), deps.config, currentMemo(deps.db), orgId);
}

/** Every flag's value, globally or for one workspace. */
export function effectiveFlags(deps: FlagDeps, orgId?: string | null): Record<FlagKey, boolean> {
  const memo = currentMemo(deps.db);
  const out = {} as Record<FlagKey, boolean>;
  for (const def of FEATURE_FLAGS) out[def.key] = evaluate(def, deps.config, memo, orgId);
  return out;
}

/** Only the flags whose value for this workspace differs from the global value (for /api/account/me). */
export function workspaceFlagDiff(deps: FlagDeps, orgId: string): Partial<Record<FlagKey, boolean>> {
  const memo = currentMemo(deps.db);
  const out: Partial<Record<FlagKey, boolean>> = {};
  if (!memo) return out;
  for (const def of FEATURE_FLAGS) {
    const mine = evaluate(def, deps.config, memo, orgId);
    if (mine !== evaluate(def, deps.config, memo)) out[def.key] = mine;
  }
  return out;
}

/**
 * The flag booleans /api/config answers, under their client names, computed the way the handler does today
 * (a flag also needs its `requires` flags on and its `needsConfig` paths set). With orgId, a workspace's view.
 */
export function clientFlags(deps: FlagDeps, orgId?: string | null): Record<string, boolean> {
  const flags = effectiveFlags(deps, orgId);
  const out: Record<string, boolean> = {};
  for (const def of FEATURE_FLAGS as readonly FlagDef[]) {
    if (!def.clientKey) continue;
    out[def.clientKey] = flags[def.key as FlagKey]
      && (def.requires ?? []).every((k) => flags[k as FlagKey])
      && (def.needsConfig ?? []).every((p) => !!readPath(deps.config, p));
  }
  return out;
}

/** The client named flags whose workspace value differs from the global /api/config value. */
export function clientFlagDiff(deps: FlagDeps, orgId: string): Record<string, boolean> {
  if (!currentMemo(deps.db)) return {};
  const mine = clientFlags(deps, orgId);
  const all = clientFlags(deps);
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(mine)) if (all[k] !== v) out[k] = v;
  return out;
}

export interface ConsoleFlagRow {
  key: FlagKey;
  env: string;
  features: boolean;
  label: string;
  description: string;
  group: string;
  scope: FlagScope;
  runtime: boolean;
  bootReason: string | null;
  requires: string[];
  envDefault: boolean;
  globalOverride: { value: boolean; locked: boolean; note: string | null; updatedBy: string | null; updatedAt: Date } | null;
  workspaceOverrideCount: number;
  effective: boolean;
}

/** The registry with each flag's env default, global override, workspace override count and global value. */
export async function listFlagsForConsole(deps: FlagDeps): Promise<ConsoleFlagRow[]> {
  await loadFlagOverrides(deps);
  const memo = currentMemo(deps.db);
  return (FEATURE_FLAGS as readonly FlagDef[]).map((def) => {
    const g = memo?.global.get(def.key);
    return {
      key: def.key as FlagKey,
      env: def.env,
      features: !!def.features,
      label: def.label,
      description: def.description,
      group: def.group,
      scope: def.scope,
      runtime: def.runtime,
      bootReason: def.bootReason ?? null,
      requires: def.requires ?? [],
      envDefault: envDefault(deps.config, def.key as FlagKey),
      globalOverride: g ? { value: g.value, locked: g.locked, note: g.note, updatedBy: g.updatedBy, updatedAt: g.updatedAt } : null,
      workspaceOverrideCount: memo?.workspace.get(def.key)?.size ?? 0,
      effective: evaluate(def, deps.config, memo),
    };
  });
}

/** Workspace overrides for one flag (every workspace) or for one workspace (every flag), newest first. */
export async function listWorkspaceOverrides(deps: FlagDeps, by: { key: string } | { orgId: string }): Promise<FlagOverride[]> {
  if ("key" in by) mustDef(by.key);
  await loadFlagOverrides(deps);
  const memo = currentMemo(deps.db);
  const rows = (memo?.rows ?? []).filter((r) => r.scopeId !== GLOBAL_SCOPE && flagDef(r.key)
    && ("key" in by ? r.key === by.key : r.scopeId === by.orgId));
  return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

function checkWritable(key: string, scopeId: string): FlagDef {
  const def = mustDef(key);
  if (!def.runtime) throw new FlagError("not_runtime", `${def.label} is set at deploy (${def.env}) and cannot be changed here.`);
  if (typeof scopeId !== "string" || scopeId.length > 100) throw new FlagError("bad_scope", "That workspace id is not valid.");
  if (scopeId !== GLOBAL_SCOPE && def.scope === "global") throw new FlagError("global_only", `${def.label} applies to the whole platform and has no per workspace setting.`);
  return def;
}

async function readRow(db: DB, key: string, scopeId: string): Promise<FlagOverride | null> {
  const [r] = await db.select().from(featureFlagOverrides)
    .where(and(eq(featureFlagOverrides.key, key), eq(featureFlagOverrides.scopeId, scopeId))).limit(1);
  return r ? toOverride(r) : null;
}

export interface SetFlagInput {
  key: string;
  /** '' for the global value, else a workspace id. */
  scopeId: string;
  value: boolean;
  /** Global rows only: workspace overrides are ignored while it stands. */
  locked?: boolean;
  note?: string | null;
  updatedBy: string | null;
}

/** Sets (or replaces) one override. Returns the row before and after, for the audit log. */
export async function setFlagOverride(deps: FlagDeps, input: SetFlagInput): Promise<{ before: FlagOverride | null; after: FlagOverride }> {
  checkWritable(input.key, input.scopeId);
  const locked = !!input.locked;
  if (locked && input.scopeId !== GLOBAL_SCOPE) throw new FlagError("lock_global_only", "Only the platform wide value can be locked.");
  const before = await readRow(deps.db, input.key, input.scopeId);
  const values = {
    value: input.value ? "on" : "off",
    locked,
    note: input.note?.trim().slice(0, 300) || null,
    updatedBy: input.updatedBy,
    updatedAt: deps.now(),
  };
  await deps.db.insert(featureFlagOverrides).values({ key: input.key, scopeId: input.scopeId, ...values })
    .onConflictDoUpdate({ target: [featureFlagOverrides.key, featureFlagOverrides.scopeId], set: values });
  invalidateFlagOverrides(deps);
  const after: FlagOverride = { key: input.key, scopeId: input.scopeId, value: input.value, locked, note: values.note, updatedBy: values.updatedBy, updatedAt: values.updatedAt };
  return { before, after };
}

/** Removes one override, so the flag falls back to the next level. */
export async function clearFlagOverride(deps: FlagDeps, input: { key: string; scopeId: string }): Promise<{ before: FlagOverride | null; after: null }> {
  checkWritable(input.key, input.scopeId);
  const before = await readRow(deps.db, input.key, input.scopeId);
  if (before) {
    await deps.db.delete(featureFlagOverrides)
      .where(and(eq(featureFlagOverrides.key, input.key), eq(featureFlagOverrides.scopeId, input.scopeId)));
  }
  invalidateFlagOverrides(deps);
  return { before, after: null };
}
