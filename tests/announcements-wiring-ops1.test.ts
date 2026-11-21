/**
 * OPS1 announcements reach customers: /api/config carries the active audience "all" announcement (never an "admins"
 * one); /api/account/me carries the one for the person's role in the current workspace ("admins" ones only for owners
 * and admins). With none stored both answer announcement: null.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { members, users } from "@/server/db/schema";
import { clearAnnouncement, publishAnnouncement } from "@/server/services/console/announcements";

const OP = { userId: "op_test", email: "op@example.com" };
const ADMINS_TEXT = "Admins only sentinel 7f3c2a9e planned maintenance";
const ALL_TEXT = "Everyone sentinel 41b8d0c6 new feature";

async function world() {
  const ctx = await makeTestApp();
  const owner = new Client(ctx.app);
  const member = new Client(ctx.app);
  await owner.signup("ann-owner@example.com", "Olga", "Ann Owner");
  await member.signup("ann-member@example.com", "Milo", "Ann Member");
  // Milo is a plain member of his workspace.
  const milo = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, "ann-member@example.com")).get())!.id;
  await ctx.db.update(members).set({ role: "member" }).where(eq(members.userId, milo));
  const anon = new Client(ctx.app);
  return { ctx, owner, member, anon };
}

describe("announcement wiring", () => {
  it("answers null everywhere with none stored", async () => {
    const { owner, anon } = await world();
    expect((await anon.get("/api/config")).body.announcement).toBeNull();
    expect((await owner.get("/api/account/me")).body.announcement).toBeNull();
  }, 60_000);

  it("an admins announcement never reaches /api/config, and reaches /me for owners and admins only", async () => {
    const { ctx, owner, member, anon } = await world();
    await publishAnnouncement(ctx.deps, { text: ADMINS_TEXT, audience: "admins", tone: "warning" }, OP);
    for (const c of [anon, owner, member]) {
      const res = await c.call("GET", "/api/config");
      expect(res.body.announcement).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("7f3c2a9e");
    }
    expect((await owner.get("/api/account/me")).body.announcement).toMatchObject({ text: ADMINS_TEXT, audience: "admins", tone: "warning" });
    const meMember = await member.get("/api/account/me");
    expect(meMember.body.organization.role).toBe("member");
    expect(meMember.body.announcement).toBeNull();
    expect(JSON.stringify(meMember.body)).not.toContain("7f3c2a9e");
  }, 60_000);

  it("an all announcement reaches /api/config and every /me, without the operator fields; clearing removes it", async () => {
    const { ctx, owner, member, anon } = await world();
    await publishAnnouncement(ctx.deps, { text: ALL_TEXT, audience: "all" }, OP);
    const cfg = (await anon.get("/api/config")).body.announcement;
    expect(cfg).toMatchObject({ text: ALL_TEXT, audience: "all", tone: "info", dismissible: true });
    expect(cfg).not.toHaveProperty("updatedBy");
    expect((await owner.get("/api/account/me")).body.announcement).toMatchObject({ text: ALL_TEXT });
    expect((await member.get("/api/account/me")).body.announcement).toMatchObject({ text: ALL_TEXT });
    await clearAnnouncement(ctx.deps, OP);
    expect((await anon.get("/api/config")).body.announcement).toBeNull();
    expect((await member.get("/api/account/me")).body.announcement).toBeNull();
  }, 60_000);

  it("an announcement outside its window is not served", async () => {
    const { ctx, owner, anon } = await world();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await publishAnnouncement(ctx.deps, { text: ALL_TEXT, audience: "all", startsAt: later }, OP);
    expect((await anon.get("/api/config")).body.announcement).toBeNull();
    expect((await owner.get("/api/account/me")).body.announcement).toBeNull();
  }, 60_000);
});
