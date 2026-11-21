/**
 * OPS1 polish: the audit log list names its targets (a workspace's name, a person's email, a flag's label) and the
 * row's workspace, read in batches for the whole page: at most two extra reads however many rows, and pages larger
 * than D1's bound variable limit still work.
 */
import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { platformAudit, withAuditNames, listPlatformAudit } from "@/server/services/console/audit";
import { FEATURE_FLAGS } from "@/shared/feature-flags";

describe("audit log target names", () => {
  it("resolves workspace, person and flag names in batches", async () => {
    const ctx = await makeTestApp();
    const { c: ops } = await signUpAs(ctx, "ops@acme.test", "admin", "Acme Ops");
    const { c: cus, id: cusId } = await signUpAs(ctx, "owner@else.test", null, "Else Inc");
    const orgId = (await cus.get("/api/account/me")).body.organization.id as string;
    const flag = FEATURE_FLAGS[0]!;

    await platformAudit(ctx.db, { action: "workspace.suspended", targetType: "workspace", targetId: orgId, orgId, reason: "Review" });
    await platformAudit(ctx.db, { action: "user.banned", targetType: "user", targetId: cusId, reason: "Spam" });
    await platformAudit(ctx.db, { action: "flags.workspace_set", targetType: "flag", targetId: flag.key, orgId, reason: "Try it" });
    await platformAudit(ctx.db, { action: "note.added", targetType: "note", targetId: "onote_x", orgId: "org_gone" });
    await platformAudit(ctx.db, { action: "workspace.suspended", targetType: "workspace", targetId: "org_gone", orgId: "org_gone", reason: "Old" });

    const r = await ops.get("/api/console/audit?limit=50");
    expect(r.status).toBe(200);
    const items = r.body.items as { action: string; targetId: string; targetLabel: string | null; orgName: string | null }[];
    const by = (action: string, targetId: string) => items.find((i) => i.action === action && i.targetId === targetId)!;
    expect(by("workspace.suspended", orgId)).toMatchObject({ targetLabel: "Else Inc", orgName: "Else Inc" });
    expect(by("user.banned", cusId)).toMatchObject({ targetLabel: "owner@else.test", orgName: null });
    expect(by("flags.workspace_set", flag.key)).toMatchObject({ targetLabel: flag.label, orgName: "Else Inc" });
    expect(by("note.added", "onote_x")).toMatchObject({ targetLabel: null, orgName: null });
    expect(by("workspace.suspended", "org_gone")).toMatchObject({ targetLabel: null, orgName: null });
  }, 120_000);

  it("reads names for a page of 150 rows in two queries, past the bound variable limit", async () => {
    const ctx = await makeTestApp();
    const { id: userId } = await signUpAs(ctx, "ops@acme.test", "admin", "Acme Ops");
    for (let i = 0; i < 150; i++) {
      await platformAudit(ctx.db, { action: "workspace.suspended", targetType: "workspace", targetId: `org_${i}`, orgId: `org_${i}` });
      await platformAudit(ctx.db, { action: "user.banned", targetType: "user", targetId: `usr_${i}` });
    }
    const page = await listPlatformAudit(ctx.db, { limit: "100" });
    const rows = [...page.items, ...(await listPlatformAudit(ctx.db, { limit: "100", cursor: page.nextCursor ?? undefined })).items];
    rows.push({ ...rows[0]!, id: "paud_me", targetType: "user", targetId: userId });
    expect(rows.length).toBe(201);
    let reads = 0;
    const counting = new Proxy(ctx.db, { get: (t, k, rcv) => (k === "select" ? (...a: unknown[]) => { reads++; return Reflect.apply(t.select, t, a); } : Reflect.get(t, k, rcv)) });
    const named = await withAuditNames(counting as typeof ctx.db, rows);
    expect(reads).toBe(2);
    expect(named.find((r) => r.targetId === userId)?.targetLabel).toBe("ops@acme.test");
  }, 120_000);
});
