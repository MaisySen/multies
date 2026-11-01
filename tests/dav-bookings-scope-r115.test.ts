import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { bookings, members, schedulingPages } from "@/server/db/schema";

/**
 * R115 (R99 low, verifier v10): the synced bookings calendar shows exactly what the person can open in the app's
 * Bookings list: bookings on their own booking pages. Checked for an admin, a member with a page, a member with
 * none, someone from another workspace, and a guest (no account, so no app password and no list).
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client, maya: Client, sam: Client, other: Client;
const pw: Record<string, string> = {};
const auth = (email: string) => `Basic ${btoa(`${email}:${pw[email]}`)}`;
const dav = (path: string, a?: string) =>
  ctx.app.request(path, { method: "PROPFIND", headers: { host: "localhost", depth: "1", "content-type": "application/xml", ...(a ? { authorization: a } : {}) }, body: `<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>` });
const davIds = async (email: string) => [...(await (await dav("/dav/cal/bookings/", auth(email))).text()).matchAll(/<d:href>\/dav\/cal\/bookings\/([^<]+)\.ics<\/d:href>/g)].map((m) => m[1]).sort();
const appIds = async (c: Client) => ((await c.get("/api/scheduling/bookings")).body.bookings as { id: string }[]).map((b) => b.id).sort();
const me = async (c: Client) => (await c.get("/api/account/me")).body.user.id as string;

let n = 0;
async function page(orgId: string, userId: string, title: string) {
  const id = `pg_r115_${++n}`;
  await ctx.db.insert(schedulingPages).values({ id, orgId, userId, slug: `r115-${n}`, title, timezone: "Australia/Sydney", hours: "{}" });
  return id;
}
async function booking(orgId: string, pageId: string, name: string) {
  const id = `bk_r115_${++n}`;
  await ctx.db.insert(bookings).values({ id, orgId, pageId, startsAt: new Date(Date.now() + 2 * 86_400_000 + n * 3_600_000), durationMin: 30, name, email: `guest${n}@example.com`, cancelTokenHash: `h${n}` });
  return id;
}

describe("R115 bookings over sync match the app's Bookings list", () => {
  const made: Record<string, string[]> = { owner: [], maya: [] };
  beforeAll(async () => {
    ctx = await makeTestApp({ DAV_SYNC_R99: "on", SCHEDULING_ENABLED: "true" });
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    maya = new Client(ctx.app);
    sam = new Client(ctx.app);
    for (const [c, email, name] of [[maya, "maya@acme.io", "Maya Lopez"], [sam, "sam@acme.io", "Sam Reed"]] as const) {
      const inv = await owner.post("/api/team/invites", { email, role: "member", mailboxIds: [] });
      await c.signup(email, name, "");
      await c.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
    }
    other = new Client(ctx.app);
    await other.signup("eve@other.io", "Eve Other", "Other Co");
    const ownerId = await me(owner), mayaId = await me(maya), eveId = await me(other);
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, ownerId)).get())!.organizationId;
    const eveOrg = (await ctx.db.select().from(members).where(eq(members.userId, eveId)).get())!.organizationId;
    const op = await page(orgId, ownerId, "Olive intro");
    for (let i = 0; i < 6; i++) made.owner.push(await booking(orgId, op, `Owner guest ${i}`));
    const m1 = await page(orgId, mayaId, "Maya demo"); // one booking page per person (unique on org and user)
    made.maya.push(await booking(orgId, m1, "Maya guest A"), await booking(orgId, m1, "Maya guest B"));
    await booking(eveOrg, await page(eveOrg, eveId, "Eve page"), "Eve guest");
    for (const [c, email] of [[owner, "owner@acme.io"], [maya, "maya@acme.io"], [sam, "sam@acme.io"], [other, "eve@other.io"]] as const) {
      pw[email] = (await c.post("/api/dav/passwords", { name: "Phone" })).body.password;
    }
  });

  it("admin: own page's bookings only, the same set in the app and over sync", async () => {
    const app = await appIds(owner);
    expect(app).toEqual([...made.owner].sort());
    expect(await davIds("owner@acme.io")).toEqual(app);
  });

  it("member with a page: their own bookings, never the admin's, the same in both", async () => {
    const app = await appIds(maya);
    expect(app).toEqual([...made.maya].sort());
    expect(await davIds("maya@acme.io")).toEqual(app);
  });

  it("member with no booking page: nothing in either", async () => {
    expect(await appIds(sam)).toEqual([]);
    expect(await davIds("sam@acme.io")).toEqual([]);
  });

  it("another workspace sees only its own", async () => {
    const app = await appIds(other);
    expect(app).toHaveLength(1);
    expect(await davIds("eve@other.io")).toEqual(app);
  });

  it("guest (no account): no list, no app password, no calendar", async () => {
    const guest = new Client(ctx.app);
    expect((await guest.get("/api/scheduling/bookings")).status).toBe(401);
    expect((await guest.post("/api/dav/passwords", { name: "Phone" })).status).toBe(401);
    expect((await dav("/dav/cal/bookings/")).status).toBe(401);
  });
});
