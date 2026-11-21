import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import {
  agents, aiUsageDaily, apiKeys, auditLogs, deliveries, domains, mailboxes, oauthClients, oauthGrants, organizations, usageCounters, webhookEndpoints,
} from "@/server/db/schema";
import {
  DETAIL_LIST_CAP, WORKSPACE_SORTS, getWorkspaceOverview, getWorkspaceUsage, listWorkspaceAgents, listWorkspaceAudit, listWorkspaceDeveloper,
  listWorkspaceDomainsAndMailboxes, listWorkspaceMembers, listWorkspaces, maskWebhookUrl, type PageRequest, type PageCursor,
} from "@/server/services/console/workspaces";
import { HttpError } from "@/server/lib/errors";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let orgId: string;

const page = (field = "createdAt", dir: "asc" | "desc" = "desc", limit = 50, cursor: PageCursor | null = null): PageRequest => ({ limit, cursor, sort: { field, dir } });

/** Every page of a list, so paging is checked end to end. */
async function all<T extends { id: string }>(fetch: (cursor: PageCursor | null) => Promise<{ items: T[]; next: PageCursor | null }>) {
  const out: T[] = [];
  let cursor: PageCursor | null = null;
  let pages = 0;
  do {
    const r = await fetch(cursor);
    out.push(...r.items);
    cursor = r.next;
    pages++;
    if (pages > 50) throw new Error("paging did not end");
  } while (cursor);
  return { items: out, pages };
}

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Ada Owner", "Acme Rockets");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
});

describe("listWorkspaces", () => {
  it("searches name, id, slug, owner email and domain", async () => {
    const other = new Client(ctx.app);
    await other.signup("boss@globex.com", "Hank Scorpio", "Globex");
    const globexId = (await other.get("/api/account/me")).body.organization.id;
    await ctx.db.update(organizations).set({ slug: "globex-corp-slug" }).where(eq(organizations.id, globexId));
    expect((await owner.post("/api/domains", { name: "rockets.example" })).status).toBe(201);

    const names = async (q: string) => (await listWorkspaces(ctx.deps, { q, page: page() })).items.map((w) => w.name).sort();
    expect(await names("acme rock")).toEqual(["Acme Rockets"]);
    expect(await names("GLOBEX")).toEqual(["Globex"]);
    expect(await names(globexId)).toEqual(["Globex"]);
    expect(await names("corp-slug")).toEqual(["Globex"]);
    expect(await names("boss@globex")).toEqual(["Globex"]);
    expect(await names("owner@acme.io")).toEqual(["Acme Rockets"]);
    expect(await names("rockets.example")).toEqual(["Acme Rockets"]);
    expect(await names("no-such-thing")).toEqual([]);
    // % and _ are literal, and a long query does not break the statement.
    expect(await names("%")).toEqual([]);
    expect(await names("x".repeat(300))).toEqual([]);

    const acme = (await listWorkspaces(ctx.deps, { q: "acme", page: page() })).items[0]!;
    expect(acme).toMatchObject({ id: orgId, ownerEmail: "owner@acme.io", members: 1, agentMembers: 0, domains: 1, plan: "starter", effectivePlan: "starter", compPlan: false });
    expect(typeof acme.createdAt).toBe("string");
  });

  it("filters by plan, comp, suspended, past due and demo", async () => {
    const mk = async (name: string, set: Partial<typeof organizations.$inferInsert>) => {
      const id = `org_${name}`;
      await ctx.db.insert(organizations).values({ id, name, timezone: "UTC", ...set });
      return id;
    };
    await mk("ProCo", { plan: "pro" });
    await mk("BizCo", { plan: "business" });
    await mk("CompCo", { compPlan: true });
    await mk("SuspCo", { suspendedAt: new Date(), suspendedReason: "spam" });
    await mk("LateCo", { pastDueSince: new Date() });
    await mk("StripeLateCo", { subscriptionStatus: "past_due" });
    await mk("DemoCo", { isDemo: true });
    const names = async (filters: Parameters<typeof listWorkspaces>[1]["filters"]) =>
      (await listWorkspaces(ctx.deps, { filters, page: page("name", "asc") })).items.map((w) => w.name);
    expect(await names({ plan: "pro" })).toEqual(["ProCo"]);
    expect(await names({ plan: "business" })).toEqual(["BizCo"]);
    expect(await names({ comp: true })).toEqual(["CompCo"]);
    expect((await listWorkspaces(ctx.deps, { filters: { comp: true }, page: page() })).items[0]!.effectivePlan).toBe("business");
    expect(await names({ suspended: true })).toEqual(["SuspCo"]);
    expect(await names({ pastDue: true })).toEqual(["LateCo", "StripeLateCo"]);
    expect(await names({ demo: true })).toEqual(["DemoCo"]);
    expect(await names({ demo: false, suspended: false, pastDue: false, comp: false, plan: "starter" })).toEqual(["Acme Rockets"]);
    expect(await names({ pastDue: false })).not.toContain("LateCo");
  });

  it("rejects a sort field outside the whitelist and a bad direction", async () => {
    expect(WORKSPACE_SORTS).toEqual(["createdAt", "name", "plan"]);
    for (const field of ["stripeCustomerId", "id; drop table users", "__proto__", "toString"]) {
      const err = await listWorkspaces(ctx.deps, { page: page(field) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).code).toBe("bad_sort");
    }
    const dir = await listWorkspaces(ctx.deps, { page: { limit: 10, cursor: null, sort: { field: "name", dir: "sideways" as "asc" } } }).catch((e: unknown) => e);
    expect((dir as HttpError).status).toBe(400);
    const cur = await listWorkspaces(ctx.deps, { page: page("createdAt", "desc", 10, { v: "not a time", id: "x" }) }).catch((e: unknown) => e);
    expect((cur as HttpError).code).toBe("bad_page");
  });

  it("pages by keyset across every sort without duplicates or gaps, including ties", async () => {
    const same = new Date("2026-01-01T00:00:00Z");
    const rows = Array.from({ length: 37 }, (_, i) => ({
      id: `org_p${String(i).padStart(2, "0")}`, name: i % 3 === 0 ? "Tied Name" : `Co ${String(i).padStart(2, "0")}`, timezone: "UTC",
      plan: (["starter", "pro", "business"] as const)[i % 3], createdAt: i < 20 ? same : new Date(same.getTime() + i * 1000),
    }));
    for (const r of rows) await ctx.db.insert(organizations).values(r);
    const expected = [...rows.map((r) => r.id), orgId].sort();
    for (const field of WORKSPACE_SORTS) {
      for (const dir of ["asc", "desc"] as const) {
        const { items, pages } = await all((cursor) => listWorkspaces(ctx.deps, { page: page(field, dir, 7, cursor) }));
        const ids = items.map((w) => w.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual(expected);
        expect(pages).toBe(Math.ceil(expected.length / 7));
        // Order holds across page edges.
        const key = (w: (typeof items)[number]) => (field === "createdAt" ? Date.parse(w.createdAt) : w[field]);
        for (let i = 1; i < items.length; i++) {
          const a = key(items[i - 1]!), b = key(items[i]!);
          if (a === b) expect(dir === "asc" ? items[i - 1]!.id < items[i]!.id : items[i - 1]!.id > items[i]!.id).toBe(true);
          else expect(dir === "asc" ? a < b : a > b).toBe(true);
        }
      }
    }
    // A search narrows paging too.
    const tied = await all((cursor) => listWorkspaces(ctx.deps, { q: "tied", page: page("name", "asc", 4, cursor) }));
    expect(tied.items).toHaveLength(13);
    // limit is clamped to 100.
    expect((await listWorkspaces(ctx.deps, { page: page("name", "asc", 10_000) })).items).toHaveLength(38);
  });
});

describe("workspace detail", () => {
  it("overview: state, limits, counts and write budget", async () => {
    await ctx.db.insert(deliveries).values([
      { id: "dlv_1", orgId, direction: "outbound", fromAddress: "a@x.io", toAddress: "b@y.io", status: "sent", provider: "log" },
      { id: "dlv_2", orgId, direction: "inbound", fromAddress: "b@y.io", toAddress: "a@x.io", status: "received", provider: "log" },
    ]);
    const o = await getWorkspaceOverview(ctx.deps, orgId);
    expect(o.org).toMatchObject({ id: orgId, name: "Acme Rockets", plan: "starter", effectivePlan: "starter", suspendedAt: null });
    expect(o.limits.domains).toBeGreaterThan(0);
    expect(o.usage).toMatchObject({ seats: 1, domains: 0 });
    expect(o.counts).toMatchObject({ members: 1, agentMembers: 0, apiKeys: 0, sendsToday: 1 });
    expect(o.writeBudget).toHaveProperty("level");
    expect(JSON.stringify(o)).not.toMatch(/usageAlerts|referralCode/);
    await expect(getWorkspaceOverview(ctx.deps, "org_missing")).rejects.toMatchObject({ status: 404 });
  });

  it("members: paged, searchable, with names and roles", async () => {
    const inv = await owner.post("/api/team/invites", { email: "second@acme.io", role: "admin" });
    const second = new Client(ctx.app);
    await second.signup("second@acme.io", "Bea Second", "Bea Co");
    expect((await second.post(`/api/invites/${String(inv.body.link).split("/invite/")[1]}/accept`)).status).toBe(200);
    const r = await all((cursor) => listWorkspaceMembers(ctx.deps, orgId, { page: page("email", "asc", 1, cursor) }));
    expect(r.items.map((m) => [m.email, m.role])).toEqual([["owner@acme.io", "owner"], ["second@acme.io", "admin"]]);
    expect(r.pages).toBe(2);
    expect((await listWorkspaceMembers(ctx.deps, orgId, { q: "bea", page: page() })).items.map((m) => m.name)).toEqual(["Bea Second"]);
    await expect(listWorkspaceMembers(ctx.deps, orgId, { page: page("role") })).rejects.toMatchObject({ code: "bad_sort" });
  });

  it("usage: totals, month counters and a dense per day series", async () => {
    const now = ctx.deps.now();
    const day = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - n * 86_400_000);
    const ymd = (n: number) => day(n).toISOString().slice(0, 10);
    await ctx.db.insert(aiUsageDaily).values([{ day: ymd(0), orgId, units: 40, calls: 4 }, { day: ymd(2), orgId, units: 10, calls: 1 }, { day: ymd(2), orgId: "*", units: 999, calls: 9 }]);
    await ctx.db.insert(usageCounters).values([
      { orgId, period: ymd(1), metric: "d1_rows", count: 123 },
      { orgId, period: now.toISOString().slice(0, 7), metric: "agent_messages", count: 7 },
    ]);
    await ctx.db.insert(deliveries).values([
      { id: "d1", orgId, direction: "outbound", fromAddress: "a", toAddress: "b", status: "sent", provider: "log", createdAt: new Date(day(0).getTime() + 1000) },
      { id: "d2", orgId, direction: "outbound", fromAddress: "a", toAddress: "b", status: "bounced", provider: "log", createdAt: new Date(day(2).getTime() + 1000) },
      { id: "d3", orgId, direction: "inbound", fromAddress: "a", toAddress: "b", status: "received", provider: "log", createdAt: new Date(day(2).getTime() + 2000) },
      { id: "d4", orgId, direction: "outbound", fromAddress: "a", toAddress: "b", status: "sent", provider: "log", createdAt: day(40) },
    ]);
    const u = await getWorkspaceUsage(ctx.deps, orgId, { days: 7 });
    expect(u.daily).toHaveLength(7);
    expect(u.range).toEqual({ from: ymd(6), to: ymd(0), days: 7 });
    const at = (n: number) => u.daily.find((d) => d.day === ymd(n))!;
    expect(at(0)).toMatchObject({ aiUnits: 40, aiCalls: 4, outbound: 1, outboundFailed: 0, inbound: 0 });
    expect(at(1).counters).toEqual({ d1_rows: 123 });
    expect(at(2)).toMatchObject({ aiUnits: 10, outbound: 1, outboundFailed: 1, inbound: 1 });
    expect(u.daily.reduce((s, d) => s + d.outbound, 0)).toBe(2); // the 40 day old send is outside the window
    expect(u.month.counters.agent_messages).toBe(7);
    expect(u.totals.agentMessages).toBe(7);
    expect((await getWorkspaceUsage(ctx.deps, orgId, { days: 10_000 })).daily).toHaveLength(90);
  });

  it("domains and mailboxes, without DKIM keys or tokens", async () => {
    const dom = (await owner.post("/api/domains", { name: "acme.io" })).body.domain;
    expect((await owner.post("/api/mailboxes", { domainId: dom.id, localPart: "hello", displayName: "Hello" })).status).toBe(201);
    const stored = await ctx.db.select().from(domains).where(eq(domains.id, dom.id)).get();
    const r = await listWorkspaceDomainsAndMailboxes(ctx.deps, orgId);
    expect(r.domains).toEqual([expect.objectContaining({ name: "acme.io", status: "pending", mailboxes: 1 })]);
    expect(r.mailboxes.map((m) => m.address)).toEqual(["hello@acme.io"]);
    expect(r.truncated).toEqual({ domains: false, mailboxes: false });
    const text = JSON.stringify(r);
    for (const secret of [stored!.dkimPrivateKeyEnc, stored!.verificationToken, stored!.dkimPublicKey]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/dkim|verificationToken/i);
    expect(DETAIL_LIST_CAP).toBe(500);
  });

  it("agents and agent members", async () => {
    const dom = (await owner.post("/api/domains", { name: "bots.io" })).body.domain;
    await ctx.db.insert(mailboxes).values({ id: "mbx_bot", orgId, domainId: dom.id, localPart: "bot", address: "bot@bots.io", displayName: "Bot", quotaMb: 100, kind: "agent" });
    await ctx.db.insert(agents).values({ id: "agt_1", orgId, mailboxId: "mbx_bot", name: "Triage", allowedRecipients: JSON.stringify(["@acme.io"]) });
    await ctx.db.insert(apiKeys).values({ id: "key_agent", orgId, name: "agent key", prefix: "mm_live_ab", keyHash: "HASH-agent-secret", agentId: "agt_1" });
    const r = await listWorkspaceAgents(ctx.deps, orgId);
    expect(r.agents).toEqual([expect.objectContaining({ id: "agt_1", name: "Triage", address: "bot@bots.io", allowedRecipients: ["@acme.io"], apiKeys: 1, status: "active" })]);
    expect(r.agentMembers).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("HASH-agent-secret");
  });

  it("developer: keys without hashes, endpoints without secrets and masked URLs, grants without hashes", async () => {
    const made = await owner.post("/api/developer/keys", { name: "CI" });
    expect(made.status).toBe(201);
    const secret: string = made.body.secret;
    const key = await ctx.db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).get();
    await ctx.db.insert(webhookEndpoints).values({
      id: "whe_1", orgId, url: "https://hooks.slack.com/services/T000/B000/SLACKTOKEN123?x=1", events: JSON.stringify(["message.received"]),
      secretEnc: "ENCRYPTED-WHSEC", format: "slack",
    });
    await ctx.db.insert(oauthClients).values({ id: "cli_1", name: "Claude", redirectUris: JSON.stringify(["https://claude.ai/cb"]) });
    const me = (await owner.get("/api/account/me")).body.user.id;
    await ctx.db.insert(oauthGrants).values({ id: "grt_1", clientId: "cli_1", orgId, userId: me, redirectUri: "https://claude.ai/cb", codeHash: "CODEHASH-x", codeChallenge: "CHALLENGE-x", refreshHash: "REFRESHHASH-x" });
    const r = await listWorkspaceDeveloper(ctx.deps, orgId);
    expect(r.apiKeys).toEqual([expect.objectContaining({ name: "CI", prefix: key!.prefix, createdByEmail: "owner@acme.io" })]);
    expect(r.webhookEndpoints).toEqual([expect.objectContaining({ id: "whe_1", url: "https://hooks.slack.com/services/…", host: "hooks.slack.com", events: ["message.received"], enabled: true })]);
    expect(r.oauthGrants).toEqual([expect.objectContaining({ id: "grt_1", clientName: "Claude", userEmail: "owner@acme.io", scope: "read", revokedAt: null })]);
    const text = JSON.stringify(r);
    for (const s of [secret, key!.keyHash, "ENCRYPTED-WHSEC", "SLACKTOKEN123", "CODEHASH-x", "CHALLENGE-x", "REFRESHHASH-x"]) expect(text).not.toContain(s);
    expect(text).not.toMatch(/keyHash|secretEnc|codeHash|refreshHash/);
    expect(maskWebhookUrl("https://example.com")).toEqual({ url: "https://example.com", host: "example.com" });
    expect(maskWebhookUrl("not a url").url).toBe("(invalid URL)");
  });

  it("audit: keyset pages over ties, filters, and masks invite ids", async () => {
    const at = new Date("2026-05-05T05:05:05Z");
    for (const row of Array.from({ length: 23 }, (_, i) => ({
      id: `aud_t${String(i).padStart(2, "0")}`, orgId, action: i % 2 ? "domain.added" : "member.invited", targetType: i === 0 ? "invitation" : "x",
      targetId: i === 0 ? "inv_supersecretlinkid" : `t${i}`, metadata: JSON.stringify({ inviteId: "inv_abcdefghijkl" }), createdAt: i < 15 ? at : new Date(at.getTime() + i),
    }))) await ctx.db.insert(auditLogs).values(row);
    const before = (await ctx.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId))).length;
    const { items } = await all((cursor) => listWorkspaceAudit(ctx.deps, orgId, { page: page("createdAt", "desc", 5, cursor) }));
    expect(items).toHaveLength(before);
    expect(new Set(items.map((i) => i.id)).size).toBe(before);
    const text = JSON.stringify(items);
    expect(text).not.toContain("inv_supersecretlinkid");
    expect(text).not.toContain("inv_abcdefghijkl");
    const filtered = await all((cursor) => listWorkspaceAudit(ctx.deps, orgId, { filter: { prefixes: ["domain."] }, page: page("createdAt", "desc", 4, cursor) }));
    expect(filtered.items).toHaveLength(11);
    await expect(listWorkspaceAudit(ctx.deps, orgId, { page: page("action") })).rejects.toMatchObject({ code: "bad_sort" });
  });
});
