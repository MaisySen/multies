/**
 * OPS1: /api/console/flags. The registry list (paging, filters, sort), one flag with its workspace overrides, one
 * workspace's flags with where each value comes from, and the four changes: set and clear the platform wide value
 * (owners, recent sign in) and a workspace's own value (ops admins and owners), each with a reason and audited.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "./helpers";
import { makeTestApp } from "./helpers";
import { signUpAs, type Ctx } from "./console-kit";
import { auditLogs, featureFlagOverrides, organizations, platformAuditLogs, sessions } from "@/server/db/schema";
import { FEATURE_FLAGS } from "@/shared/feature-flags";
import { invalidateFlagOverrides } from "@/server/services/console/flags";

type C = Client;
const WS_FLAG = "mailArchive"; // workspace scoped, runtime, off by default
const GLOBAL_FLAG = "mailSplitCounts"; // platform wide only, on by default
const DEPLOY_FLAG = "chatPlus"; // set at deploy

const del = (c: C, p: string, body?: unknown) => c.call("DELETE", p, body);
const orgIdOf = async (ctx: Ctx, name: string) => (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, name)).get())!.id;
const auditRows = (ctx: Ctx, action: string) => ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action)).all();

describe("/api/console/flags", () => {
  let ctx: Ctx;
  let owner: C, opsAdmin: C, support: C, readonly: C, customer: C;
  let ownerId: string;
  let orgA: string, orgB: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    invalidateFlagOverrides();
    ({ c: owner, id: ownerId } = await signUpAs(ctx, "own@ops.test", "admin", "Owner HQ"));
    ({ c: opsAdmin } = await signUpAs(ctx, "adm@ops.test", "ops_admin", "Admin HQ"));
    ({ c: support } = await signUpAs(ctx, "sup@ops.test", "ops_support", "Support HQ"));
    ({ c: readonly } = await signUpAs(ctx, "ro@ops.test", "ops_readonly", "Readonly HQ"));
    ({ c: customer } = await signUpAs(ctx, "cus@else.test", null, "Acme Flags A"));
    await signUpAs(ctx, "cus2@else.test", null, "Bravo Flags B");
    orgA = await orgIdOf(ctx, "Acme Flags A");
    orgB = await orgIdOf(ctx, "Bravo Flags B");
  }, 120_000);

  it("lists every flag with its default, overrides and value; pages with nextCursor; filters; refuses a bad sort", async () => {
    const all = await readonly.get("/api/console/flags?limit=200");
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(FEATURE_FLAGS.length);
    expect(all.body.nextCursor).toBeNull();
    const row = all.body.items.find((r: { key: string }) => r.key === WS_FLAG);
    expect(row).toMatchObject({ key: WS_FLAG, label: "Mail archive and retention", envDefault: false, globalOverride: null, workspaceOverrideCount: 0, effective: false, runtime: true, scope: "workspace" });
    expect(all.body.items.find((r: { key: string }) => r.key === DEPLOY_FLAG)).toMatchObject({ runtime: false, bootReason: expect.any(String) });

    const p1 = await readonly.get("/api/console/flags?limit=10");
    expect(p1.body.items).toHaveLength(10);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await readonly.get(`/api/console/flags?limit=10&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items).toHaveLength(10);
    const seen = [...p1.body.items, ...p2.body.items].map((r: { key: string }) => r.key);
    expect(new Set(seen).size).toBe(20);
    expect(seen).toEqual(all.body.items.slice(0, 20).map((r: { key: string }) => r.key));
    expect((await readonly.get("/api/console/flags?cursor=not-a-cursor")).status).toBe(400);

    const group = await readonly.get(`/api/console/flags?group=${encodeURIComponent("Mail and inbox")}`);
    expect(group.body.items.length).toBeGreaterThan(0);
    expect(group.body.items.every((r: { group: string }) => r.group === "Mail and inbox")).toBe(true);
    const deploy = await readonly.get("/api/console/flags?state=deploy");
    expect(deploy.body.items.every((r: { runtime: boolean }) => !r.runtime)).toBe(true);
    const q = await readonly.get("/api/console/flags?q=archive");
    expect(q.body.items.map((r: { key: string }) => r.key)).toContain(WS_FLAG);
    const byLabel = await readonly.get("/api/console/flags?sort=label:asc&limit=200");
    const labels = byLabel.body.items.map((r: { label: string }) => r.label);
    expect(labels).toEqual([...labels].sort((a: string, b: string) => a.localeCompare(b)));

    expect((await readonly.get("/api/console/flags?sort=env:asc")).status).toBeGreaterThanOrEqual(400);
    expect((await readonly.get("/api/console/flags?sort=label:sideways")).status).toBeGreaterThanOrEqual(400);
    expect((await readonly.get("/api/console/flags?group=Nope")).status).toBeGreaterThanOrEqual(400);
  });

  it("non operators get 401 or 403 on every flags route", async () => {
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/console/flags")).status).toBe(401);
    expect((await customer.get("/api/console/flags")).status).toBe(403);
    expect((await customer.get(`/api/console/flags/${WS_FLAG}`)).status).toBe(403);
    expect((await customer.put(`/api/console/flags/${WS_FLAG}/workspaces/${orgA}`, { value: true, reason: "Trying it" })).status).toBe(403);
    expect((await customer.put(`/api/console/flags/${WS_FLAG}/global`, { value: true, reason: "Trying it" })).status).toBe(403);
    expect((await anon.call("DELETE", `/api/console/flags/${WS_FLAG}/global`, { reason: "Trying it" })).status).toBe(401);
  });

  it("sets and clears a workspace's own value: reason required, ops admin allowed, support refused, audited", async () => {
    const path = `/api/console/flags/${WS_FLAG}/workspaces/${orgA}`;
    expect((await opsAdmin.put(path, { value: true })).status).toBe(422);
    expect((await opsAdmin.put(path, { value: true, reason: "no" })).status).toBe(422);
    const refused = await support.put(path, { value: true, reason: "Customer asked for it" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
    expect((await readonly.put(path, { value: true, reason: "Customer asked for it" })).status).toBe(403);
    expect((await opsAdmin.put(`/api/console/flags/${WS_FLAG}/workspaces/org_does_not_exist`, { value: true, reason: "Customer asked for it" })).status).toBe(404);
    expect((await opsAdmin.put(`/api/console/flags/noSuchFlag/workspaces/${orgA}`, { value: true, reason: "Customer asked for it" })).status).toBe(404);

    const ok = await opsAdmin.put(path, { value: true, note: "Pilot", reason: "Customer pilot for archive" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, override: { value: true } });

    const [row] = await auditRows(ctx, "flags.workspace_set");
    expect(row).toMatchObject({ targetType: "flag", targetId: WS_FLAG, orgId: orgA, reason: "Customer pilot for archive", actorEmail: "adm@ops.test", actorRole: "ops_admin" });
    expect(JSON.parse(row.after!)).toEqual({ value: "on", locked: false, note: "Pilot" });
    expect(JSON.parse(row.before ?? "null")).toBeNull();
    // The customer's own Activity log shows it too.
    const ws = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgA), eq(auditLogs.action, "flags.workspace_set"))).all();
    expect(ws).toHaveLength(1);

    // The workspace's view: on, from its own setting; the other workspace keeps the default.
    const a = await readonly.get(`/api/console/flags/workspaces/${orgA}?limit=200`);
    expect(a.status).toBe(200);
    expect(a.body.workspace).toEqual({ id: orgA, name: "Acme Flags A" });
    expect(a.body.items.find((r: { key: string }) => r.key === WS_FLAG)).toMatchObject({ effective: true, source: "workspace", platformValue: false, workspaceOverride: { value: true, note: "Pilot", applies: true }, blocked: null });
    expect(a.body.items.find((r: { key: string }) => r.key === GLOBAL_FLAG)).toMatchObject({ source: "default", blocked: "global_only" });
    expect(a.body.items.find((r: { key: string }) => r.key === DEPLOY_FLAG)).toMatchObject({ blocked: "deploy", runtime: false });
    const own = await readonly.get(`/api/console/flags/workspaces/${orgA}?state=own`);
    expect(own.body.items.map((r: { key: string }) => r.key)).toEqual([WS_FLAG]);
    const b = await readonly.get(`/api/console/flags/workspaces/${orgB}?limit=200`);
    expect(b.body.items.find((r: { key: string }) => r.key === WS_FLAG)).toMatchObject({ effective: false, source: "default", workspaceOverride: null });
    expect((await readonly.get("/api/console/flags/workspaces/org_does_not_exist")).status).toBe(404);
    const wp1 = await readonly.get(`/api/console/flags/workspaces/${orgA}?limit=5`);
    expect(wp1.body.items).toHaveLength(5);
    const wp2 = await readonly.get(`/api/console/flags/workspaces/${orgA}?limit=5&cursor=${encodeURIComponent(wp1.body.nextCursor)}`);
    expect(wp2.body.items[0].key).toBe(a.body.items[5].key);

    // The flag's detail lists the workspace by name; the list counts it.
    await opsAdmin.put(`/api/console/flags/${WS_FLAG}/workspaces/${orgB}`, { value: false, reason: "Second workspace stays off" });
    const d = await readonly.get(`/api/console/flags/${WS_FLAG}`);
    expect(d.status).toBe(200);
    expect(d.body.flag).toMatchObject({ key: WS_FLAG, workspaceOverrideCount: 2 });
    expect(d.body.overrides.items.map((o: { workspaceName: string }) => o.workspaceName).sort()).toEqual(["Acme Flags A", "Bravo Flags B"]);
    expect(d.body.overrides.items.find((o: { orgId: string }) => o.orgId === orgA)).toMatchObject({ value: true, note: "Pilot", updatedByEmail: "adm@ops.test" });
    const dp = await readonly.get(`/api/console/flags/${WS_FLAG}?limit=1`);
    expect(dp.body.overrides.items).toHaveLength(1);
    const dp2 = await readonly.get(`/api/console/flags/${WS_FLAG}?limit=1&cursor=${encodeURIComponent(dp.body.overrides.nextCursor)}`);
    expect(dp2.body.overrides.items).toHaveLength(1);
    expect(dp2.body.overrides.items[0].orgId).not.toBe(dp.body.overrides.items[0].orgId);
    expect(dp2.body.overrides.nextCursor).toBeNull();
    expect((await readonly.get("/api/console/flags/noSuchFlag")).status).toBe(404);
    const listed = await readonly.get("/api/console/flags?state=workspaces");
    expect(listed.body.items.map((r: { key: string }) => r.key)).toEqual([WS_FLAG]);
    // "Changed from default" (the page's default view) includes a flag changed only for some workspaces.
    const modified = await readonly.get("/api/console/flags?state=modified");
    expect(modified.body.items.map((r: { key: string }) => r.key)).toEqual([WS_FLAG]);

    // Clear: reason required, support refused, then removed and audited; clearing again is a 404.
    expect((await del(opsAdmin, path, {})).status).toBe(422);
    expect((await del(support, path, { reason: "Pilot is over" })).status).toBe(403);
    expect((await del(opsAdmin, path, { reason: "Pilot is over" })).status).toBe(200);
    const [cleared] = await auditRows(ctx, "flags.workspace_cleared");
    expect(cleared).toMatchObject({ targetId: WS_FLAG, orgId: orgA, reason: "Pilot is over" });
    expect(JSON.parse(cleared.before!)).toMatchObject({ value: "on" });
    const again = await del(opsAdmin, path, { reason: "Pilot is over" });
    expect(again.status).toBe(404);
    expect(await auditRows(ctx, "flags.workspace_cleared")).toHaveLength(1);
    expect((await readonly.get(`/api/console/flags/workspaces/${orgA}?limit=200`)).body.items.find((r: { key: string }) => r.key === WS_FLAG)).toMatchObject({ effective: false, source: "default" });
  }, 60_000);

  it("refuses workspace values for platform wide and set at deploy flags with plain 400s", async () => {
    const g = await opsAdmin.put(`/api/console/flags/${GLOBAL_FLAG}/workspaces/${orgA}`, { value: false, reason: "Trying a workspace value" });
    expect(g.status).toBe(400);
    expect(g.body.error.code).toBe("global_only");
    expect(g.body.error.message).toMatch(/whole platform/);
    const d = await owner.put(`/api/console/flags/${DEPLOY_FLAG}/global`, { value: false, reason: "Trying a deploy flag" });
    expect(d.status).toBe(400);
    expect(d.body.error.code).toBe("not_runtime");
    expect(await auditRows(ctx, "flags.global_set")).toHaveLength(0);
  });

  it("sets, locks and clears the platform wide value: owners only, recent sign in, audited", async () => {
    const path = `/api/console/flags/${WS_FLAG}/global`;
    expect((await owner.put(path, { value: true })).status).toBe(422);
    const adm = await opsAdmin.put(path, { value: true, reason: "Roll out to everyone" });
    expect(adm.status).toBe(403);
    expect(adm.body.error.code).toBe("forbidden");

    // A workspace setting first, then a locked platform value overrides it.
    await opsAdmin.put(`/api/console/flags/${WS_FLAG}/workspaces/${orgA}`, { value: true, reason: "Customer pilot again" });
    const set = await owner.put(path, { value: false, locked: true, note: "Incident", reason: "Turn off everywhere during the incident" });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ ok: true, override: { value: false, locked: true } });
    const [row] = await auditRows(ctx, "flags.global_set");
    expect(row).toMatchObject({ targetType: "flag", targetId: WS_FLAG, orgId: null, reason: "Turn off everywhere during the incident", actorRole: "admin" });
    expect(JSON.parse(row.after!)).toEqual({ value: "off", locked: true, note: "Incident" });

    const listed = (await readonly.get("/api/console/flags?state=changed")).body.items;
    expect(listed.map((r: { key: string }) => r.key)).toEqual([WS_FLAG]);
    expect(listed[0]).toMatchObject({ globalOverride: { value: false, locked: true, note: "Incident", updatedByEmail: "own@ops.test" }, effective: false });
    expect((await readonly.get("/api/console/flags?state=modified")).body.items.map((r: { key: string }) => r.key)).toEqual([WS_FLAG]);
    const a = await readonly.get(`/api/console/flags/workspaces/${orgA}?limit=200`);
    expect(a.body.items.find((r: { key: string }) => r.key === WS_FLAG)).toMatchObject({ effective: false, source: "locked", blocked: "locked", workspaceOverride: { value: true, applies: false } });
    const detail = await readonly.get(`/api/console/flags/${WS_FLAG}`);
    expect(detail.body.overrides.items[0]).toMatchObject({ orgId: orgA, applies: false });

    // A lock is not a workspace thing.
    expect((await opsAdmin.put(`/api/console/flags/${WS_FLAG}/workspaces/${orgA}`, { value: true, locked: true, reason: "Lock it here" })).status).toBe(200); // locked is ignored by the workspace schema
    // Step up: an older sign in is asked to sign in again.
    await ctx.db.update(sessions).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(sessions.userId, ownerId));
    const stale = await del(owner, path, { reason: "Incident is over" });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("step_up_required");
    await ctx.db.update(sessions).set({ createdAt: new Date() }).where(eq(sessions.userId, ownerId));

    expect((await del(owner, path, { reason: "x" })).status).toBe(422);
    expect((await del(opsAdmin, path, { reason: "Incident is over" })).status).toBe(403);
    expect((await del(owner, path, { reason: "Incident is over" })).status).toBe(200);
    const [cleared] = await auditRows(ctx, "flags.global_cleared");
    expect(cleared).toMatchObject({ targetId: WS_FLAG, reason: "Incident is over" });
    expect(JSON.parse(cleared.before!)).toEqual({ value: "off", locked: true, note: "Incident" });
    expect((await del(owner, path, { reason: "Incident is over" })).status).toBe(404);
    const rows = await ctx.db.select().from(featureFlagOverrides).where(eq(featureFlagOverrides.scopeId, "")).all();
    expect(rows).toHaveLength(0);
    // With the lock gone the workspace's own value applies again.
    const back = await readonly.get(`/api/console/flags/workspaces/${orgA}?limit=200`);
    expect(back.body.items.find((r: { key: string }) => r.key === WS_FLAG)).toMatchObject({ effective: true, source: "workspace" });
  }, 60_000);
});
