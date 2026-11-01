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

describe("R115 the app's Bookings list pages through every booking", () => {
  it("returns pages of the asked size with a cursor until the last, in start order, without repeats", async () => {
    const pat = sam; // the member with no page so far (checked empty above) gets one now
    const patId = await me(pat);
    const orgId = (await ctx.db.select().from(members).where(eq(members.userId, await me(owner))).get())!.organizationId;
    const pg = await page(orgId, patId, "Pat calls");
    const ids: string[] = [];
    for (let i = 0; i < 125; i++) ids.push(await booking(orgId, pg, `Caller ${i}`));
    // Two bookings at the same moment still page by id.
    const same = await booking(orgId, pg, "Same time");
    await ctx.db.update(bookings).set({ startsAt: (await ctx.db.select().from(bookings).where(eq(bookings.id, ids[60])).get())!.startsAt }).where(eq(bookings.id, same));
    const first = (await pat.get("/api/scheduling/bookings?upcoming=1")).body as { bookings: { id: string; startsAt: string }[]; nextCursor: string | null };
    expect(first.bookings).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const seen: { id: string; startsAt: string }[] = [];
    let cursor = "";
    for (let n = 0; n < 10; n++) {
      const r = (await pat.get(`/api/scheduling/bookings?upcoming=1&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body as typeof first;
      seen.push(...r.bookings);
      if (!r.nextCursor) break;
      expect(r.bookings).toHaveLength(50);
      cursor = r.nextCursor;
    }
    expect(seen).toHaveLength(126);
    expect(new Set(seen.map((b) => b.id)).size).toBe(126);
    const times = seen.map((b) => Date.parse(b.startsAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Another member never pages into Pat's bookings; a broken cursor reads from the start.
    expect((await maya.get(`/api/scheduling/bookings?limit=50&cursor=${encodeURIComponent(cursor)}`)).body.bookings.every((b: { id: string }) => !ids.includes(b.id))).toBe(true);
    expect((await pat.get("/api/scheduling/bookings?limit=50&cursor=nonsense")).body.bookings[0].id).toBe(seen[0].id);
  });
});
