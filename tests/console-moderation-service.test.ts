import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { abuseEvents, contentReports, organizations } from "@/server/db/schema";
import { platformAudit } from "@/server/services/console/audit";
import {
  abuseSummaryByWorkspace, actOnReportForConsole, listAbuseEvents, listReports, listSuspendedWorkspaces, reportCounts, resolveAbuseEvents,
  suspendWorkspace, unsuspendWorkspace, type PageCursor, type PageRequest, type Paged,
} from "@/server/services/console/moderation";

/** OPS1: the console's moderation data layer, over real rows in two workspaces. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let orgA: string, orgB: string, userA: string, userB: string;
const NOW = new Date("2026-11-20T12:00:00.000Z").getTime();
const H = 3600_000;

async function account(email: string, name: string, workspace: string) {
  const c = new Client(ctx.app);
  await c.signup(email, name, workspace);
  const me = (await c.get("/api/account/me")).body;
  return { c, userId: me.user.id as string, orgId: me.organization.id as string };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  const a = await account("olive@acme.io", "Olive Owner", "Acme");
  const b = await account("bea@beta.io", "Bea Boss", "Beta Works");
  orgA = a.orgId; orgB = b.orgId; userA = a.userId; userB = b.userId;
  ctx.deps.now = () => new Date(NOW);
});

/** Inserts in batches of 5 rows, under D1's 100 variable limit. */
async function insertAll<T>(rows: T[], insert: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 5) await insert(rows.slice(i, i + 5));
}

const pageOf = <F extends string>(field: F, dir: "asc" | "desc", limit: number, cursor: PageCursor | null = null): PageRequest<F> => ({ limit, cursor, sort: { field, dir } });

/** Walks every page and returns the ids in order. */
async function walk<T extends { id?: string; orgId?: string }>(fetch: (cursor: PageCursor | null) => Promise<Paged<T>>, idOf: (t: T) => string) {
  const ids: string[] = [];
  let cursor: PageCursor | null = null;
  for (let i = 0; i < 100; i++) {
    const p: Paged<T> = await fetch(cursor);
    ids.push(...p.items.map(idOf));
    if (!p.next) break;
    cursor = p.next;
  }
  return ids;
}

async function seedReports() {
  const reasons = ["spam", "harassment", "hate", "other"] as const;
  const rows: (typeof contentReports.$inferInsert)[] = [];
  for (let i = 0; i < 23; i++) {
    // Pairs share a timestamp, so the id tie breaker matters.
    const at = new Date(NOW - Math.floor(i / 2) * 3 * H);
    rows.push({
      id: `rpt_a${String(i).padStart(2, "0")}`, reporterUserId: userA, orgId: i % 3 === 0 ? orgB : orgA, targetType: "user", targetUserId: userB,
      reason: reasons[i % 4], note: i === 5 ? "Needle in the haystack" : null, status: i % 5 === 4 ? "resolved" : "open", createdAt: at,
    });
  }
  await insertAll(rows, (part) => ctx.db.insert(contentReports).values(part));
  return rows;
}

describe("reports", () => {
  it("filters by status, reason, workspace and search, with workspace names", async () => {
    const rows = await seedReports();
    const all = await listReports(ctx.deps, { status: "all", page: pageOf("createdAt", "desc", 200) });
    expect(all.items).toHaveLength(23);
    expect(all.next).toBeNull();
    const open = await listReports(ctx.deps, { status: "open", page: pageOf("createdAt", "desc", 200) });
    expect(open.items.map((r) => r.id).sort()).toEqual(rows.filter((r) => r.status === "open").map((r) => r.id).sort());
    const spam = await listReports(ctx.deps, { status: "all", reason: "spam", page: pageOf("createdAt", "desc", 200) });
    expect(spam.items.every((r) => r.reason === "spam")).toBe(true);
    expect(spam.items).toHaveLength(rows.filter((r) => r.reason === "spam").length);
    const beta = await listReports(ctx.deps, { status: "all", orgId: orgB, page: pageOf("createdAt", "desc", 200) });
    expect(beta.items).toHaveLength(rows.filter((r) => r.orgId === orgB).length);
    expect(beta.items.every((r) => r.orgId === orgB && r.workspaceName === "Beta Works")).toBe(true);
    const needle = await listReports(ctx.deps, { status: "all", q: "NEEDLE", page: pageOf("createdAt", "desc", 50) });
    expect(needle.items.map((r) => r.id)).toEqual(["rpt_a05"]);
    const byWorkspace = await listReports(ctx.deps, { status: "all", q: "beta works", page: pageOf("createdAt", "desc", 200) });
    expect(byWorkspace.items).toHaveLength(beta.items.length);
    const byEmail = await listReports(ctx.deps, { status: "all", q: "bea@beta", page: pageOf("createdAt", "desc", 200) });
    expect(byEmail.items).toHaveLength(23);
    const first = all.items[0]!;
    expect(first).toMatchObject({ reporter: { id: userA, name: "Olive Owner", email: "olive@acme.io" }, target: { id: userB, name: "Bea Boss", suspended: false }, ageHours: 0 });
  });

  it("pages without duplicates or gaps in both directions, and refuses unknown sort fields", async () => {
    await seedReports();
    const full = (await listReports(ctx.deps, { status: "all", page: pageOf("createdAt", "desc", 200) })).items.map((r) => r.id);
    for (const dir of ["desc", "asc"] as const) {
      const ids = await walk((cursor) => listReports(ctx.deps, { status: "all", page: pageOf("createdAt", dir, 4, cursor) }), (r) => r.id);
      expect(new Set(ids).size).toBe(23);
      expect(ids).toEqual(dir === "desc" ? full : [...full].reverse());
    }
    const p = await listReports(ctx.deps, { status: "all", page: pageOf("createdAt", "desc", 4) });
    expect(typeof p.next?.v).toBe("number");
    await expect(listReports(ctx.deps, { status: "all", page: pageOf("note" as "createdAt", "desc", 4) })).rejects.toMatchObject({ status: 400, code: "bad_sort" });
  });

  it("counts open reports and the 12 and 24 hour buckets", async () => {
    await ctx.db.insert(contentReports).values([
      { id: "rpt_1", reporterUserId: userA, orgId: orgA, targetType: "user", targetUserId: userB, reason: "spam", createdAt: new Date(NOW - 1 * H) },
      { id: "rpt_2", reporterUserId: userA, orgId: orgA, targetType: "user", targetUserId: userB, reason: "spam", createdAt: new Date(NOW - 13 * H) },
      { id: "rpt_3", reporterUserId: userA, orgId: orgB, targetType: "user", targetUserId: userB, reason: "spam", createdAt: new Date(NOW - 30 * H) },
      { id: "rpt_4", reporterUserId: userA, orgId: orgB, targetType: "user", targetUserId: userB, reason: "spam", createdAt: new Date(NOW - 50 * H), status: "dismissed" },
    ]);
    expect(await reportCounts(ctx.deps)).toEqual({ open: 3, olderThan12h: 2, olderThan24h: 1, oldestAt: new Date(NOW - 30 * H).toISOString() });
  });

  it("acts on a report through the existing action and gives before and after", async () => {
    await ctx.db.insert(contentReports).values({ id: "rpt_x", reporterUserId: userA, orgId: orgA, targetType: "user", targetUserId: userB, reason: "spam", createdAt: new Date(NOW - H) });
    const r = await actOnReportForConsole(ctx.deps, { userId: userA }, "rpt_x", { action: "dismiss", note: "Not spam" });
    expect(r.before).toEqual({ status: "open", action: "none", targetUserId: userB, workspaceId: orgA });
    expect(r.after).toEqual({ status: "dismissed", action: "none", targetUserId: userB, workspaceId: orgA });
    expect(r.report).toMatchObject({ id: "rpt_x", status: "dismissed", resolutionNote: "Not spam" });
    expect((await reportCounts(ctx.deps)).open).toBe(0);
    await expect(actOnReportForConsole(ctx.deps, { userId: userA }, "rpt_missing", { action: "dismiss" })).rejects.toMatchObject({ status: 404 });
  });
});

async function seedAbuse() {
  const rows: (typeof abuseEvents.$inferInsert)[] = [];
  for (let i = 0; i < 150; i++) {
    rows.push({
      id: `abu_${String(i).padStart(3, "0")}`, orgId: i % 2 ? orgB : orgA, kind: i % 3 ? "outbound_flagged" : "outbound_held",
      score: i % 7, detail: `rule ${i}`, createdAt: new Date(NOW - Math.floor(i / 3) * H), resolvedAt: i >= 140 ? new Date(NOW) : null,
    });
  }
  await insertAll(rows, (part) => ctx.db.insert(abuseEvents).values(part));
  return rows;
}

describe("abuse signals", () => {
  it("lists past the old cap of 100 with filters and pages by date and by score", async () => {
    const rows = await seedAbuse();
    const open = await walk((cursor) => listAbuseEvents(ctx.deps, { resolved: false, page: pageOf("createdAt", "desc", 30, cursor) }), (e) => e.id);
    expect(open).toHaveLength(140);
    expect(new Set(open).size).toBe(140);
    const byScore = await walk((cursor) => listAbuseEvents(ctx.deps, { page: pageOf("score", "desc", 11, cursor) }), (e) => e.id);
    expect(new Set(byScore).size).toBe(150);
    const scores = byScore.map((id) => rows.find((r) => r.id === id)!.score!);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    const held = await listAbuseEvents(ctx.deps, { kind: "outbound_held", orgId: orgA, resolved: false, page: pageOf("createdAt", "desc", 200) });
    expect(held.items.every((e) => e.kind === "outbound_held" && e.orgId === orgA && e.workspaceName === "Acme" && e.resolvedAt === null)).toBe(true);
    expect(held.items).toHaveLength(rows.filter((r) => r.kind === "outbound_held" && r.orgId === orgA && !r.resolvedAt).length);
    const resolved = await listAbuseEvents(ctx.deps, { resolved: true, page: pageOf("createdAt", "desc", 200) });
    expect(resolved.items).toHaveLength(10);
  });

  it("summarises open signals per workspace", async () => {
    await ctx.db.insert(abuseEvents).values([
      { id: "abu_1", orgId: orgA, kind: "outbound_flagged", score: 7, createdAt: new Date(NOW - 2 * H) },
      { id: "abu_2", orgId: orgA, kind: "outbound_held", score: 12, createdAt: new Date(NOW - H) },
      { id: "abu_3", orgId: orgB, kind: "outbound_flagged", score: 6, createdAt: new Date(NOW - H) },
      { id: "abu_4", orgId: orgB, kind: "outbound_held", score: 30, createdAt: new Date(NOW - H), resolvedAt: new Date(NOW) },
    ]);
    expect(await abuseSummaryByWorkspace(ctx.deps)).toEqual([
      { orgId: orgA, workspaceName: "Acme", openEvents: 2, topScore: 12, lastEventAt: new Date(NOW - H).toISOString(), suspended: false },
      { orgId: orgB, workspaceName: "Beta Works", openEvents: 1, topScore: 6, lastEventAt: new Date(NOW - H).toISOString(), suspended: false },
    ]);
  });

  it("resolves by ids (more than the D1 variable limit) and by workspace", async () => {
    const rows = await seedAbuse();
    const ids = rows.slice(0, 120).map((r) => r.id!);
    const r = await resolveAbuseEvents(ctx.deps, { ids });
    expect(r.before.count).toBe(120);
    expect(r.before.ids).toHaveLength(100);
    expect(r.before.orgIds.sort()).toEqual([orgA, orgB].sort());
    expect(r.after).toEqual({ resolvedAt: new Date(NOW).toISOString(), count: 120 });
    // Again: nothing left open among them.
    expect((await resolveAbuseEvents(ctx.deps, { ids })).after).toEqual({ resolvedAt: null, count: 0 });
    const left = rows.filter((x, i) => i >= 120 && i < 140);
    const byOrg = await resolveAbuseEvents(ctx.deps, { orgId: orgA });
    expect(byOrg.before.count).toBe(left.filter((x) => x.orgId === orgA).length);
    expect(byOrg.before.orgIds).toEqual([orgA]);
    const still = await listAbuseEvents(ctx.deps, { resolved: false, page: pageOf("createdAt", "desc", 200) });
    expect(still.items.map((e) => e.orgId)).toEqual(left.filter((x) => x.orgId === orgB).map(() => orgB));
  });
});

describe("suspended workspaces", () => {
  it("suspends and lifts with before and after, and lists who suspended from the audit trail", async () => {
    await ctx.db.insert(abuseEvents).values({ id: "abu_s", orgId: orgA, kind: "outbound_held", score: 11, createdAt: new Date(NOW - H) });
    const s = await suspendWorkspace(ctx.deps, orgA, "Phishing links");
    expect(s).toEqual({ orgId: orgA, before: { suspendedAt: null, suspendedReason: null }, after: { suspendedAt: new Date(NOW).toISOString(), suspendedReason: "Phishing links" } });
    // An older suspension row of the same workspace does not count; the route writes this one after the change.
    await platformAudit(ctx.db, { action: "workspace.suspended", targetType: "workspace", targetId: orgA, orgId: orgA, actorUserId: "old", actorEmail: "old@multies.io", at: new Date(NOW - 100 * H) });
    await platformAudit(ctx.db, { action: "workspace.suspended", targetType: "workspace", targetId: orgA, orgId: orgA, actorUserId: userB, actorEmail: "bea@beta.io", reason: "Phishing links", at: new Date(NOW + 5) });
    await ctx.db.update(organizations).set({ suspendedAt: new Date(NOW - 5 * H), suspendedReason: "Automatic: repeated messages held by the spam filter. An operator will review it." }).where(eq(organizations.id, orgB));

    const list = await listSuspendedWorkspaces(ctx.deps, pageOf("suspendedAt", "desc", 50));
    expect(list.next).toBeNull();
    expect(list.items).toEqual([
      { orgId: orgA, workspaceName: "Acme", suspendedAt: new Date(NOW).toISOString(), reason: "Phishing links", automatic: false, suspendedBy: { userId: userB, email: "bea@beta.io" }, openAbuseEvents: 1 },
      { orgId: orgB, workspaceName: "Beta Works", suspendedAt: new Date(NOW - 5 * H).toISOString(), reason: expect.stringMatching(/^Automatic:/), automatic: true, suspendedBy: null, openAbuseEvents: 0 },
    ]);
    const byName = await walk((cursor) => listSuspendedWorkspaces(ctx.deps, pageOf("name", "asc", 1, cursor)), (w) => w.orgId);
    expect(byName).toEqual([orgA, orgB]);

    const u = await unsuspendWorkspace(ctx.deps, orgA);
    expect(u).toEqual({ orgId: orgA, before: { suspendedAt: new Date(NOW).toISOString(), suspendedReason: "Phishing links" }, after: { suspendedAt: null, suspendedReason: null }, resolvedAbuseEvents: 1 });
    expect((await listSuspendedWorkspaces(ctx.deps, pageOf("suspendedAt", "desc", 50))).items.map((w) => w.orgId)).toEqual([orgB]);
    await expect(suspendWorkspace(ctx.deps, "org_missing", "x")).rejects.toMatchObject({ status: 404 });
  });
});
