/**
 * OPS1: /api/console/announcements: read the current announcement with its status, publish and remove with a reason
 * (ops_admin and owner only), each audited; a remove with nothing stored is 404 and writes no audit row.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { signUpAs } from "./console-kit";
import { platformAuditLogs } from "@/server/db/schema";

async function setup() {
  const ctx = await makeTestApp();
  const { c: admin, id: adminId } = await signUpAs(ctx, "opsadmin@ops.test", "ops_admin");
  const { c: owner } = await signUpAs(ctx, "owner@ops.test", "admin");
  const { c: support } = await signUpAs(ctx, "support@ops.test", "ops_support");
  const { c: readonly } = await signUpAs(ctx, "readonly@ops.test", "ops_readonly");
  const { c: customer } = await signUpAs(ctx, "customer@else.test", null);
  return { ctx, admin, adminId, owner, support, readonly, customer };
}

const rowsFor = (ctx: Awaited<ReturnType<typeof makeTestApp>>, action: string) =>
  ctx.db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action)).all();

const del = (c: Client, body: unknown) => c.call("DELETE", "/api/console/announcements", body);

describe("/api/console/announcements", () => {
  it("reads an empty state; every operator may read; customers and anonymous callers are refused", async () => {
    const { ctx, readonly, customer } = await setup();
    const r = await readonly.get("/api/console/announcements");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ announcement: null, status: null, updatedByEmail: null });
    expect((await customer.get("/api/console/announcements")).status).toBe(403);
    expect((await new Client(ctx.app).get("/api/console/announcements")).status).toBe(401);
  }, 60_000);

  it("publishing needs a reason and valid input; nothing is written otherwise", async () => {
    const { ctx, admin } = await setup();
    expect((await admin.put("/api/console/announcements", { text: "Maintenance tonight" })).status).toBe(422);
    expect((await admin.put("/api/console/announcements", { text: "Maintenance tonight", reason: "no" })).status).toBe(422);
    const bad = await admin.put("/api/console/announcements", { text: "<b>Hi</b>", reason: "Planned work" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields).toHaveProperty("text");
    expect((await admin.put("/api/console/announcements", { text: "Hi", linkLabel: "Open", linkUrl: "http://x.example", reason: "Planned work" })).status).toBe(422);
    expect((await admin.put("/api/console/announcements", { text: "Hi", extra: 1, reason: "Planned work" })).status).toBe(422);
    expect((await admin.get("/api/console/announcements")).body.announcement).toBeNull();
    expect(await rowsFor(ctx, "announcement.published")).toHaveLength(0);
  }, 60_000);

  it("ops_admin publishes, replaces and removes; each change is audited with its reason", async () => {
    const { ctx, admin, adminId, owner } = await setup();
    const p = await admin.put("/api/console/announcements", {
      text: "Scheduled maintenance tonight at 22:00 UTC.", tone: "warning", audience: "admins",
      linkLabel: "Status page", linkUrl: "https://status.example.com/", dismissible: false, reason: "Planned database work",
    });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ ok: true, status: "live", updatedByEmail: "opsadmin@ops.test" });
    expect(p.body.announcement).toMatchObject({ text: "Scheduled maintenance tonight at 22:00 UTC.", tone: "warning", audience: "admins", dismissible: false, updatedBy: adminId });
    const id1 = p.body.announcement.id as string;

    const g = await owner.get("/api/console/announcements");
    expect(g.body.announcement.id).toBe(id1);
    expect(g.body.status).toBe("live");

    // A start far in the future reads as scheduled; one that already ended reads as ended.
    const later = await owner.put("/api/console/announcements", { text: "New pricing next year", startsAt: "2999-01-01T00:00:00Z", reason: "Pricing notice" });
    expect(later.body.status).toBe("scheduled");
    const ended = await owner.put("/api/console/announcements", { text: "Old news", endsAt: "2000-01-02T00:00:00Z", reason: "Testing the end" });
    expect(ended.body.status).toBe("ended");

    const pubs = await rowsFor(ctx, "announcement.published");
    expect(pubs).toHaveLength(3);
    const first = pubs.find((x) => x.reason === "Planned database work")!;
    expect(first).toMatchObject({ actorUserId: adminId, actorRole: "ops_admin", targetType: "announcement", targetId: id1 });
    expect(first.before).toBeNull();
    expect(JSON.parse(first.after!)).toMatchObject({ id: id1, tone: "warning" });
    const second = pubs.find((x) => x.reason === "Pricing notice")!;
    expect(JSON.parse(second.before!).id).toBe(id1);

    expect((await del(admin, {})).status).toBe(422);
    const lastId = ended.body.announcement.id as string;
    const d = await del(admin, { reason: "Work finished" });
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ ok: true, announcement: null, status: null, updatedByEmail: null });
    expect((await admin.get("/api/console/announcements")).body.announcement).toBeNull();
    const clears = await rowsFor(ctx, "announcement.cleared");
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ targetType: "announcement", targetId: lastId, reason: "Work finished", after: null });
    expect(JSON.parse(clears[0]!.before!).text).toBe("Old news");

    // Nothing left: 404 and no second audit row.
    const again = await del(admin, { reason: "Work finished" });
    expect(again.status).toBe(404);
    expect(again.body.error.message).toBe("There is no announcement to remove.");
    expect(await rowsFor(ctx, "announcement.cleared")).toHaveLength(1);
  }, 90_000);

  it("support, read only and customers cannot publish or remove; anonymous callers get 401", async () => {
    const { ctx, admin, support, readonly, customer } = await setup();
    await admin.put("/api/console/announcements", { text: "Keep me", reason: "Planned work" });
    const body = { text: "Nope", reason: "Trying it out" };
    for (const c of [support, readonly, customer]) {
      const r = await c.put("/api/console/announcements", body);
      expect(r.status).toBe(403);
      expect((await del(c, { reason: "Trying it out" })).status).toBe(403);
    }
    expect((await support.put("/api/console/announcements", body)).body.error.code).toBe("forbidden");
    const anon = new Client(ctx.app);
    expect((await anon.put("/api/console/announcements", body)).status).toBe(401);
    expect((await del(anon, { reason: "Trying it out" })).status).toBe(401);
    expect((await admin.get("/api/console/announcements")).body.announcement.text).toBe("Keep me");
    expect(await rowsFor(ctx, "announcement.published")).toHaveLength(1);
    expect(await rowsFor(ctx, "announcement.cleared")).toHaveLength(0);
  }, 60_000);
});
