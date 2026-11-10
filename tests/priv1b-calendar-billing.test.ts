/**
 * PRIV1b batch "calendar-billing": P45 (calendar fetch guard), P54 (calendar truncation), P64 (empty meeting start),
 * P19 (comp plan read everywhere), P65 (live chat sockets end when a person is removed or signs out everywhere).
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meetings, organizations } from "@/server/db/schema";
import { checkUrl, davRequest, DAV_MAX_BYTES } from "@/server/services/suite/caldav";
import { clearCalendarCache } from "@/server/services/suite/calendar-sync";
import { effectivePlanId } from "@/server/services/plans";
import { meetingMinutes } from "@/server/services/suite/meeting-minutes-r34";
import { readToolState } from "@/server/services/tools/usage";
import { aiUsage, planOf } from "@/server/services/tools/ai-meter";
import { keptUsage } from "@/server/services/tools/kept-files";
import { CLOSE_REVOKED, MemoryChatHub, type HubConn } from "@/server/realtime/hub";

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
const DOH = "https://cloudflare-dns.com/";
/** A DNS over HTTPS answer: `ip` for type A, nothing for AAAA. */
const doh = (url: string, ip: string) => Response.json({ Answer: url.endsWith("type=A") ? [{ type: 1, data: ip }] : [] });
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Holidays\r\nEND:VCALENDAR\r\n";

/** A fetch that answers DNS (private for *.nip.io names that spell a private address) and serves `routes`. */
function web(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(DOH)) {
      const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
      return doh(url, /^169\.254\.|^10\./.test(name) ? name.replace(/\.nip\.io$/, "") : "93.184.216.34");
    }
    calls.push(url);
    const r = routes[url];
    return r ? r() : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function world(fetcher?: typeof fetch) {
  clearCalendarCache();
  const ctx = await makeTestApp({}, fetcher ? { fetch: fetcher } : {});
  ctx.deps.now = () => new Date("2026-10-26T03:00:00Z");
  const owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "member", mailboxIds: [] });
  const maya = new Client(ctx.app);
  await maya.signup("maya@acme.io", "Maya Lopez", "");
  await maya.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`);
  const me = (await owner.get("/api/account/me")).body;
  const mayaId = (await maya.get("/api/account/me")).body.user.id as string;
  return { ctx, owner, maya, orgId: me.organization.id as string, ownerId: me.user.id as string, mayaId };
}

describe("P45: calendar links go through the safe fetch rules", () => {
  it("a name that resolves to a private address, or a non web port, is refused before any request", async () => {
    const w = web({});
    await expect(davRequest({ fetch: w.fetch, allowPrivateHosts: false }, "https://169.254.169.254.nip.io/latest/meta-data", { method: "GET" }))
      .rejects.toMatchObject({ code: "unreachable", status: 502 });
    expect(w.calls).toEqual([]);
    expect(() => checkUrl("https://example.com:6379/x", false)).toThrow();
    expect(checkUrl("https://example.com:443/x.ics", false).hostname).toBe("example.com");
  });

  it("the add form gives one text for a private answer, a dead port or an odd status; a public ICS link still works", async () => {
    const w = web({
      "https://cal.public.io/ok.ics": () => new Response(ICS, { headers: { "content-type": "text/calendar" } }),
      "https://cal.public.io/500.ics": () => new Response("boom", { status: 500 }),
      "https://cal.public.io/down.ics": () => { throw new TypeError("connection refused"); },
    });
    const { owner } = await world(w.fetch);
    const texts = new Set<string>();
    for (const url of ["https://10.0.0.5.nip.io/cal.ics", "https://cal.public.io/500.ics", "https://cal.public.io/down.ics"]) {
      const r = await owner.post("/api/calendar/sources", { kind: "ics", url });
      expect(r.status).toBe(502);
      expect(r.body.error.code).toBe("unreachable");
      expect(r.body.error.message).not.toMatch(/500/);
      texts.add(r.body.error.message);
    }
    expect(texts.size).toBe(1);
    expect(w.calls.some((u) => u.includes("10.0.0.5"))).toBe(false);
    const ok = await owner.post("/api/calendar/sources", { kind: "ics", url: "https://cal.public.io/ok.ics" });
    expect(ok.status).toBeLessThan(300);
    expect(ok.body.source.name).toBe("Holidays");
  }, 60_000);

  it("the body is capped and the deadline covers it", async () => {
    const big = "x".repeat(DAV_MAX_BYTES + 1000);
    const w = web({ "https://cal.public.io/big.ics": () => new Response(big) });
    const r = await davRequest({ fetch: w.fetch, allowPrivateHosts: false }, "https://cal.public.io/big.ics", { method: "GET" });
    expect(r.text.length).toBe(DAV_MAX_BYTES);
    // A server that sends headers and then trickles forever: the request ends at the deadline.
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(DOH)) return doh(url, "93.184.216.34");
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("BEGIN:VCALENDAR\r\n")); init?.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } });
      return new Response(body);
    }) as typeof fetch;
    const t0 = Date.now();
    await expect(davRequest({ fetch: slow, allowPrivateHosts: false, timeoutMs: 300 }, "https://cal.public.io/slow.ics", { method: "GET" })).rejects.toMatchObject({ code: "unreachable" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("P54: a person's calendar is filtered before the limit", () => {
  it("2,000 other meetings no longer hide the person's own; cancelled series stop matching", async () => {
    const { ctx, owner, maya, orgId, ownerId } = await world();
    const made = await maya.post("/api/meetings", { title: "Maya 1:1", startsAt: "2026-11-20T01:00:00Z", durationMin: 30 });
    expect(made.status).toBe(201);
    const invited = await owner.post("/api/meetings", { title: "Owner invites Maya", startsAt: "2026-11-21T01:00:00Z", durationMin: 30, invitees: ["Maya@acme.io"] });
    expect(invited.status).toBe(201);
    const count = async (c: Client) => ((await c.get("/api/calendar/events?from=2026-11-01&to=2026-12-01")).body.events as { kind: string; title: string }[]).filter((e) => e.kind === "meeting");
    expect((await count(maya)).map((e) => e.title).sort()).toEqual(["Maya 1:1", "Owner invites Maya"]);
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `mtg_x${i}`, orgId, title: `Other ${i}`, room: `r${i}`, guestToken: `g${i}`, startsAt: new Date(Date.UTC(2026, 10, 2, 0, i % 60)), durationMin: 30, createdByType: "member" as const, createdById: ownerId }));
    for (let i = 0; i < rows.length; i += 5) await ctx.db.insert(meetings).values(rows.slice(i, i + 5));
    expect((await count(maya)).map((e) => e.title).sort()).toEqual(["Maya 1:1", "Owner invites Maya"]);
    // The owner's own meetings are still theirs; Maya sees none of them.
    expect((await count(owner)).length).toBeGreaterThan(0);
    expect((await count(maya)).some((e) => e.title.startsWith("Other"))).toBe(false);
    // A cancelled weekly series from long ago no longer matches every window.
    await ctx.db.insert(meetings).values({ id: "mtg_old", orgId, title: "Old series", room: "ro", guestToken: "go", startsAt: new Date("2025-01-06T01:00:00Z"), durationMin: 30, createdByType: "member", createdById: ownerId, recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", recurrenceTz: "UTC", status: "cancelled" });
    const raw = (await ctx.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.id, "mtg_old")).get());
    expect(raw?.id).toBe("mtg_old");
    const { workItems } = await import("@/server/services/suite/calendar-sync");
    const items = await workItems(ctx.deps, orgId, { id: ownerId, email: "owner@acme.io" }, new Date("2026-11-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"), { includeTasks: false, limit: 3000 });
    expect(items.meetings.some((m) => m.id === "mtg_old")).toBe(false);
  }, 120_000);
});

describe("P64: an empty meeting start is refused", () => {
  it("PATCH with startsAt '' or garbage answers 422 and keeps the start; a real start still moves it", async () => {
    const { owner } = await world();
    const made = await owner.post("/api/meetings", { title: "x", startsAt: "2026-11-20T01:00:00Z", durationMin: 30 });
    const id = made.body.meeting.id as string;
    for (const startsAt of ["", "not a date"]) {
      const r = await owner.patch(`/api/meetings/${id}`, { startsAt });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("validation_failed");
    }
    const ok = await owner.patch(`/api/meetings/${id}`, { startsAt: "2026-11-21T02:00:00Z" });
    expect(ok.status).toBe(200);
    expect(ok.body.meeting.startsAt).toBe("2026-11-21T02:00:00.000Z");
  }, 60_000);
});

describe("P19: a comp workspace counts as Business everywhere", () => {
  async function comp(ctx: Ctx, orgId: string, on: boolean) {
    await ctx.db.update(organizations).set({ plan: "starter", compPlan: on }).where(eq(organizations.id, orgId));
  }
  it("helper, meeting minutes, tool limits, AI meter, kept files and the billing page", async () => {
    expect(effectivePlanId({ plan: "starter", compPlan: true })).toBe("business");
    expect(effectivePlanId({ plan: "starter", compPlan: 1 })).toBe("business");
    expect(effectivePlanId({ plan: "pro", compPlan: false })).toBe("pro");
    expect(effectivePlanId({ plan: "weird" })).toBe("starter");
    const { ctx, owner, orgId } = await world();
    await comp(ctx, orgId, true);
    expect((await meetingMinutes(ctx.deps, orgId, true)).cap).toBeNull();
    expect((await readToolState(ctx.db, orgId, new Date()))!.plan).toBe("business");
    expect(await planOf(ctx.deps, orgId)).toBe("business");
    expect((await aiUsage(ctx.deps, orgId)).plan).toBe("business");
    const kept = await keptUsage(ctx.deps, orgId);
    const bill = await owner.get("/api/billing");
    expect(bill.status).toBe(200);
    expect(bill.body.plan.id).toBe("business");
    expect(bill.body.compPlan).toBe(true);
    // A normal Free workspace still reads as Free.
    await comp(ctx, orgId, false);
    expect((await meetingMinutes(ctx.deps, orgId, true)).cap).not.toBeNull();
    expect((await readToolState(ctx.db, orgId, new Date()))!.plan).toBe("starter");
    expect(await planOf(ctx.deps, orgId)).toBe("starter");
    expect((await keptUsage(ctx.deps, orgId)).cap).toBeLessThan(kept.cap);
    const free = await owner.get("/api/billing");
    expect(free.body.plan.id).toBe("starter");
    expect(free.body.compPlan).toBe(false);
  }, 60_000);

  it("a comp workspace cannot start an add-on checkout (409 comp_plan); a normal one still can", async () => {
    const { ctx, owner, orgId } = await world();
    await comp(ctx, orgId, true);
    const r = await owner.post("/api/billing/addons", { addons: { send_boost: 1 } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("comp_plan");
    await comp(ctx, orgId, false);
    const ok = await owner.post("/api/billing/addons", { addons: { send_boost: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toBe(true);
  }, 60_000);
});

describe("P65: live chat sockets end with membership and sessions", () => {
  function conn(userId: string) {
    const closed: number[] = [];
    const c: HubConn = { userId, openedAt: Date.now(), send: () => undefined, close: (code) => { closed.push(code); } };
    return { c, closed };
  }
  it("removing a member closes their sockets at once; others keep theirs", async () => {
    const { ctx, owner, orgId, mayaId, ownerId } = await world();
    const hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    const m = conn(mayaId), o = conn(ownerId);
    hub.join(orgId, m.c); hub.join(orgId, o.c);
    expect((await owner.del(`/api/team/members/${mayaId}`)).status).toBe(200);
    expect(m.closed).toEqual([CLOSE_REVOKED]);
    expect(o.closed).toEqual([]);
    expect([...(hub.hubs.get(orgId) ?? [])].map((x) => x.userId)).toEqual([ownerId]);
  }, 60_000);

  it("signing out everywhere closes the person's sockets", async () => {
    const { ctx, maya, orgId, mayaId, ownerId } = await world();
    const hub = new MemoryChatHub();
    ctx.deps.chatLive = hub;
    const m = conn(mayaId), o = conn(ownerId);
    hub.join(orgId, m.c); hub.join(orgId, o.c);
    expect((await maya.post("/api/auth/revoke-sessions", {})).status).toBe(200);
    expect(m.closed).toEqual([CLOSE_REVOKED]);
    expect(o.closed).toEqual([]);
  }, 60_000);
});
