/**
 * OPS1: the runtime feature flag engine (services/console/flags.ts) over the registry (src/shared/feature-flags.ts).
 * No rows must mean today's env behaviour exactly; overrides apply env -> global -> workspace with a locked global
 * row winning; reads never write and select the table at most once per 60 seconds.
 */
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers";
import { featureFlagOverrides } from "@/server/db/schema";
import type { DB } from "@/server/db";
import { CONFIG_NON_FLAG_KEYS, FEATURE_FLAGS, flagDef, type FlagDef, type FlagKey } from "@/shared/feature-flags";
import {
  FLAG_MEMO_MS, FlagError, clearFlagOverride, clientFlagDiff, clientFlags, effectiveFlags, envDefault, featureOn,
  invalidateFlagOverrides, listFlagsForConsole, listWorkspaceOverrides, loadFlagOverrides, setFlagOverride, workspaceFlagDiff,
  type FlagDeps,
} from "@/server/services/console/flags";

const DEFS = FEATURE_FLAGS as readonly FlagDef[];
const KEYS = DEFS.map((d) => d.key as FlagKey);
const ORG = "org_a";
const OTHER = "org_b";

/** Every registry env var set to one value (plus the video service, so the call recording flags can show). */
function envAll(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const d of DEFS) env[d.env] = value;
  if (value !== "off") Object.assign(env, { LIVEKIT_URL: "wss://video.example.test", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" });
  return env;
}

/** The boolean answers of the real /api/config, minus the ones that are not operator switches. */
async function configBooleans(app: { request: (p: string) => Response | Promise<Response> }) {
  const body = await (await app.request("/api/config")).json() as Record<string, unknown>;
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean>;
}

/** Counts statements and row changes on the test database. */
function meter(db: DB) {
  const client = (db as unknown as { $client: { prepare: (sql: string) => { get: () => { n: number } } } }).$client;
  const prepare = client.prepare.bind(client);
  const seen: string[] = [];
  client.prepare = (sql: string) => { seen.push(sql); return prepare(sql); };
  const changes = () => Number(prepare("select total_changes() as n").get().n);
  return {
    selects: () => seen.filter((s) => /^\s*select/i.test(s) && /feature_flag_overrides/.test(s)).length,
    writes: () => seen.filter((s) => /^\s*(insert|update|delete|replace)/i.test(s)).length,
    changes,
    reset: () => { seen.length = 0; },
  };
}

async function raw(db: DB, key: string, scopeId: string, value: string, locked = false) {
  await db.insert(featureFlagOverrides).values({ key, scopeId, value, locked, updatedAt: new Date() });
}

afterEach(() => invalidateFlagOverrides());

describe("registry", () => {
  it("has unique keys, client keys and env names, and every requirement names a real flag", () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    const clientKeys = DEFS.flatMap((d) => (d.clientKey ? [d.clientKey] : []));
    expect(new Set(clientKeys).size).toBe(clientKeys.length);
    expect(new Set(DEFS.map((d) => d.env)).size).toBe(DEFS.length);
    for (const d of DEFS) for (const r of d.requires ?? []) expect(flagDef(r), `${d.key} requires ${r}`).toBeTruthy();
    for (const d of DEFS) if (!d.runtime) expect(d.bootReason, d.key).toBeTruthy();
    for (const d of DEFS) expect(`${d.label} ${d.description}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("covers every boolean flag /api/config exposes", async () => {
    for (const env of [{}, envAll("true")]) {
      const { app } = await makeTestApp(env);
      const exposed = Object.keys(await configBooleans(app));
      expect(exposed.length).toBeGreaterThan(40);
      const known = new Set([...DEFS.flatMap((d) => (d.clientKey ? [d.clientKey] : [])), ...Object.keys(CONFIG_NON_FLAG_KEYS)]);
      expect(exposed.filter((k) => !known.has(k)), "add these /api/config booleans to src/shared/feature-flags.ts").toEqual([]);
      // And nothing in the registry claims a client name /api/config does not answer.
      const missing = DEFS.filter((d) => d.clientKey && !exposed.includes(d.clientKey)).map((d) => d.key);
      expect(missing).toEqual([]);
    }
  });

  it("each env var really drives its config path (all on, all off)", async () => {
    const on = await makeTestApp(envAll("true"));
    const off = await makeTestApp(envAll("off"));
    for (const k of KEYS) {
      expect(envDefault(on.deps.config, k), `${k} with its env on`).toBe(true);
      expect(envDefault(off.deps.config, k), `${k} with its env off`).toBe(false);
    }
  });

  it("FEATURES names turn on the flags marked features", async () => {
    const listed = DEFS.filter((d) => d.features);
    expect(listed.length).toBeGreaterThan(0);
    const { deps } = await makeTestApp({ FEATURES: listed.map((d) => d.env).join(",") });
    for (const d of listed) expect(envDefault(deps.config, d.key as FlagKey), d.key).toBe(true);
  });
});

describe("no rows equals today's env behaviour", () => {
  for (const [name, env] of [["defaults", {}], ["all on", envAll("true")], ["all off", envAll("off")], ["mixed", { FLOWS: "off", CRM_TIMELINE: "on", FEATURES: "LANG_R104", INVOICES_ENABLED: "1", BILL_TD4: "on", FILES_PLUS_R101: "on" }]] as const) {
    it(`matches the config and /api/config (${name})`, async () => {
      const { app, deps } = await makeTestApp(env as Record<string, string>);
      await loadFlagOverrides(deps);
      for (const k of KEYS) {
        expect(featureOn(deps, k), k).toBe(envDefault(deps.config, k));
        expect(featureOn(deps, k, ORG), k).toBe(envDefault(deps.config, k));
      }
      expect(effectiveFlags(deps, ORG)).toEqual(effectiveFlags(deps));
      expect(workspaceFlagDiff(deps, ORG)).toEqual({});
      expect(clientFlagDiff(deps, ORG)).toEqual({});
      const answered = await configBooleans(app);
      for (const k of Object.keys(CONFIG_NON_FLAG_KEYS)) delete answered[k];
      expect(clientFlags(deps)).toEqual(answered);
      expect(clientFlags(deps, ORG)).toEqual(answered);
    });
  }

  it("answers the env default before anything is loaded", async () => {
    const { deps, db } = await makeTestApp({ CRM_TIMELINE: "on" });
    await raw(db, "crmTimeline", "", "off");
    expect(featureOn(deps, "crmTimeline")).toBe(true);
  });
});

describe("evaluation order", () => {
  it("env -> global -> workspace", async () => {
    const { deps } = await makeTestApp({});
    const actor = "usr_op";
    await setFlagOverride(deps, { key: "crmTimeline", scopeId: "", value: true, note: "pilot", updatedBy: actor });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "crmTimeline")).toBe(true);
    expect(featureOn(deps, "crmTimeline", ORG)).toBe(true);
    await setFlagOverride(deps, { key: "crmTimeline", scopeId: ORG, value: false, updatedBy: actor });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "crmTimeline")).toBe(true);
    expect(featureOn(deps, "crmTimeline", ORG)).toBe(false);
    expect(featureOn(deps, "crmTimeline", OTHER)).toBe(true);
    // A workspace can be turned on while the platform stays off.
    await setFlagOverride(deps, { key: "tasksPlus", scopeId: OTHER, value: true, updatedBy: actor });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "tasksPlus")).toBe(false);
    expect(featureOn(deps, "tasksPlus", OTHER)).toBe(true);
    // Clearing falls back a level.
    await clearFlagOverride(deps, { key: "crmTimeline", scopeId: "" });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "crmTimeline")).toBe(false);
    expect(featureOn(deps, "crmTimeline", ORG)).toBe(false);
    await clearFlagOverride(deps, { key: "crmTimeline", scopeId: ORG });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "crmTimeline", ORG)).toBe(false);
  });

  it("an on-unless-off flag can be turned off globally", async () => {
    const { deps } = await makeTestApp({});
    expect(envDefault(deps.config, "flows")).toBe(true);
    await setFlagOverride(deps, { key: "flows", scopeId: "", value: false, updatedBy: null });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "flows")).toBe(false);
    expect(clientFlags(deps).flows).toBe(false);
  });

  it("a locked global row beats workspace rows", async () => {
    const { deps } = await makeTestApp({ SEARCH_R98: "on" });
    await setFlagOverride(deps, { key: "searchR98", scopeId: ORG, value: true, updatedBy: null });
    await setFlagOverride(deps, { key: "searchR98", scopeId: "", value: false, updatedBy: null });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "searchR98", ORG)).toBe(true); // unlocked: the workspace row wins
    await setFlagOverride(deps, { key: "searchR98", scopeId: "", value: false, locked: true, note: "incident", updatedBy: null });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "searchR98", ORG)).toBe(false);
    expect(featureOn(deps, "searchR98")).toBe(false);
    expect(workspaceFlagDiff(deps, ORG)).toEqual({});
  });

  it("ignores workspace rows on global flags and any row on a boot flag", async () => {
    const { deps, db } = await makeTestApp({ TOURS_R130: "on" });
    await raw(db, "passkeyDes1", ORG, "on");
    await raw(db, "toursR130", "", "off");
    await raw(db, "toursR130", ORG, "off");
    await raw(db, "notAFlag", "", "on");
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "passkeyDes1", ORG)).toBe(false);
    expect(featureOn(deps, "toursR130")).toBe(true);
    expect(featureOn(deps, "toursR130", ORG)).toBe(true);
    expect(await listWorkspaceOverrides(deps, { orgId: ORG })).toHaveLength(2); // the passkey and tours rows; not the unknown key
  });

  it("client flags keep the /api/config requirements", async () => {
    const { deps } = await makeTestApp({ INVOICES_ENABLED: "1", BILL_TD4: "on", EXPENSES_R106: "on" });
    await loadFlagOverrides(deps);
    expect(clientFlags(deps).billTd4).toBe(true);
    await setFlagOverride(deps, { key: "invoicesEnabled", scopeId: ORG, value: false, updatedBy: null });
    await loadFlagOverrides(deps);
    expect(clientFlags(deps, ORG)).toMatchObject({ invoices: false, billTd4: false, expenses: false });
    expect(clientFlagDiff(deps, ORG)).toEqual({ invoices: false, billTd4: false, expenses: false });
    expect(workspaceFlagDiff(deps, ORG)).toEqual({ invoicesEnabled: false });
  });
});

describe("rejections", () => {
  it("refuses unknown keys, boot flags, workspace rows on global flags and workspace locks", async () => {
    const { deps } = await makeTestApp({});
    const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { expect(e).toBeInstanceOf(FlagError); return (e as FlagError).code; } };
    expect(await code(setFlagOverride(deps, { key: "nope", scopeId: "", value: true, updatedBy: null }))).toBe("unknown_flag");
    expect(await code(clearFlagOverride(deps, { key: "nope", scopeId: "" }))).toBe("unknown_flag");
    expect(await code(setFlagOverride(deps, { key: "sites", scopeId: "", value: true, updatedBy: null }))).toBe("not_runtime");
    expect(await code(setFlagOverride(deps, { key: "demoEnabled", scopeId: "", value: true, updatedBy: null }))).toBe("not_runtime");
    expect(await code(setFlagOverride(deps, { key: "passkeyDes1", scopeId: ORG, value: true, updatedBy: null }))).toBe("global_only");
    expect(await code(setFlagOverride(deps, { key: "crmTimeline", scopeId: ORG, value: true, locked: true, updatedBy: null }))).toBe("lock_global_only");
    expect(await code(listWorkspaceOverrides(deps, { key: "nope" }))).toBe("unknown_flag");
    expect(() => featureOn(deps, "nope" as FlagKey)).toThrow(FlagError);
    expect(await code(setFlagOverride(deps, { key: "passkeyDes1", scopeId: "", value: true, updatedBy: null }))).toBe("ok");
  });
});

describe("memo, invalidation and writes", () => {
  it("one select per 60 seconds, zero writes on reads", async () => {
    let now = new Date("2026-11-21T10:00:00Z").getTime();
    const { deps: base, db } = await makeTestApp({});
    const deps: FlagDeps = { ...base, now: () => new Date(now) };
    const m = meter(db);
    const before = m.changes();
    await Promise.all([loadFlagOverrides(deps), loadFlagOverrides(deps)]);
    await loadFlagOverrides(deps);
    expect(m.selects()).toBe(1);
    effectiveFlags(deps, ORG); workspaceFlagDiff(deps, ORG); clientFlags(deps, ORG); featureOn(deps, "flows", ORG);
    await listFlagsForConsole(deps);
    await listWorkspaceOverrides(deps, { orgId: ORG });
    await listWorkspaceOverrides(deps, { key: "crmTimeline" });
    expect(m.selects()).toBe(1);
    expect(m.writes()).toBe(0);
    expect(m.changes()).toBe(before);

    // A row written behind the memo's back shows only after 60 seconds.
    await raw(db, "crmTimeline", "", "on");
    m.reset();
    now += FLAG_MEMO_MS - 1;
    await loadFlagOverrides(deps);
    expect(m.selects()).toBe(0);
    expect(featureOn(deps, "crmTimeline")).toBe(false);
    now += 1;
    await loadFlagOverrides(deps);
    expect(m.selects()).toBe(1);
    expect(featureOn(deps, "crmTimeline")).toBe(true);

    // invalidate makes the next load read again at once.
    await raw(db, "tasksPlus", "", "on");
    invalidateFlagOverrides();
    expect(featureOn(deps, "tasksPlus")).toBe(false); // nothing loaded: env default
    await loadFlagOverrides(deps);
    expect(m.selects()).toBe(2);
    expect(featureOn(deps, "tasksPlus")).toBe(true);
  });

  it("a change through setFlagOverride is visible on the next load and returns before and after", async () => {
    const { deps } = await makeTestApp({});
    await loadFlagOverrides(deps);
    const first = await setFlagOverride(deps, { key: "webinar", scopeId: "", value: true, note: "  launch ", updatedBy: "usr_1" });
    expect(first.before).toBeNull();
    expect(first.after).toMatchObject({ key: "webinar", scopeId: "", value: true, locked: false, note: "launch", updatedBy: "usr_1" });
    await loadFlagOverrides(deps);
    expect(featureOn(deps, "webinar")).toBe(true);
    const second = await setFlagOverride(deps, { key: "webinar", scopeId: "", value: false, locked: true, updatedBy: "usr_2" });
    expect(second.before).toMatchObject({ value: true, locked: false, note: "launch" });
    expect(second.after).toMatchObject({ value: false, locked: true, note: null });
    const cleared = await clearFlagOverride(deps, { key: "webinar", scopeId: "" });
    expect(cleared).toMatchObject({ before: { value: false, locked: true }, after: null });
    expect((await clearFlagOverride(deps, { key: "webinar", scopeId: "" })).before).toBeNull();
  });
});

describe("console listing", () => {
  it("shows env default, global override, workspace count and the global value", async () => {
    const { deps } = await makeTestApp({ CRM_TIMELINE: "on" });
    await setFlagOverride(deps, { key: "crmTimeline", scopeId: "", value: false, note: "paused", updatedBy: "usr_1" });
    await setFlagOverride(deps, { key: "crmTimeline", scopeId: ORG, value: true, updatedBy: "usr_1" });
    await setFlagOverride(deps, { key: "crmTimeline", scopeId: OTHER, value: true, updatedBy: "usr_1" });
    const rows = await listFlagsForConsole(deps);
    expect(rows.map((r) => r.key)).toEqual(KEYS);
    const crm = rows.find((r) => r.key === "crmTimeline")!;
    expect(crm).toMatchObject({ envDefault: true, effective: false, workspaceOverrideCount: 2, globalOverride: { value: false, locked: false, note: "paused" }, runtime: true, scope: "workspace" });
    const sites = rows.find((r) => r.key === "sites")!;
    expect(sites).toMatchObject({ runtime: false, globalOverride: null, workspaceOverrideCount: 0 });
    expect(sites.bootReason).toBeTruthy();
    expect((await listWorkspaceOverrides(deps, { key: "crmTimeline" })).map((r) => r.scopeId).sort()).toEqual([ORG, OTHER]);
    expect((await listWorkspaceOverrides(deps, { orgId: ORG })).map((r) => r.key)).toEqual(["crmTimeline"]);
  });
});
