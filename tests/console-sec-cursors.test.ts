/**
 * OPS1 security review (info item, and M1's audit): every console list answers a tampered cursor of the wrong type
 * with 400 bad_cursor (never 500), and a nextCursor never carries a value the page's items do not show.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { assertCursorFromItems, signUpAs, type Ctx } from "./console-kit";
import { consoleRoutes } from "@/server/routes/console";
import { apiKeys, deliveries, members, organizations, suppressions, webhookDeliveries, webhookEndpoints } from "@/server/db/schema";
import type { Client } from "./helpers";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Wrong for the default sorts (every list's default sort is a time or a number): a string, a boolean, an object, no id, junk. */
const WRONG = [
  b64({ v: "not-a-number", t: "s", id: "x" }),
  b64({ v: true, t: "s", id: "x" }),
  b64({ v: { a: 1 }, t: "n", id: "x" }),
  b64({ v: 5, t: "d" }),
  b64([1, 2]),
  "%%%",
];
/** Wrong for a text sort: a number or a date. */
const WRONG_FOR_TEXT = [b64({ v: 1_700_000_000_000, t: "n", id: "x" }), b64({ v: 1_700_000_000_000, t: "d", id: "x" })];

/** Every GET console list path with no path parameter, plus the workspace scoped ones on a real workspace. */
function listPaths(orgId: string): string[] {
  const out = new Set<string>();
  for (const r of consoleRoutes().routes) {
    if (r.method !== "GET") continue;
    const p = r.path.replace(/\/$/, "");
    if (/\/(me|export|registry|status|stats|counts|snapshot|summary)$/.test(p)) continue;
    if (p.includes(":")) {
      if (/^\/api\/console\/workspaces\/:id\/(members|queued-sends|audit)$/.test(p)) out.add(p.replace(":id", orgId));
      continue;
    }
    // The operators list sorts by email by default; page it by a time so the string cursor is the wrong type.
    out.add(p === "/api/console/operators" ? `${p}?sort=createdAt:desc` : p);
  }
  return [...out];
}

describe("console lists and cursors", () => {
  let ctx: Ctx;
  let owner: Client;
  let orgId: string;
  beforeAll(async () => {
    ctx = await makeTestApp();
    owner = (await signUpAs(ctx, "owner@ops.test", "admin", "Ops")).c;
    const cus = await signUpAs(ctx, "cus@example.com", null, "Cus");
    orgId = (await ctx.db.select().from(members).where(eq(members.userId, cus.id)).get())!.organizationId;
    for (let i = 0; i < 3; i++) await signUpAs(ctx, `u${i}@example.com`, null, `W${i}`);
    // Two rows in each list that gained ownerEmail (billing, mail, developer), so limit=1 pages carry a cursor.
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      await ctx.db.insert(apiKeys).values({ id: `key_c${i}`, orgId, name: `Key ${i}`, prefix: `mk_live_c${i}`, keyHash: `hash-secret-${i}-9d8c7b6a`, scope: "full" });
      await ctx.db.insert(webhookEndpoints).values({ id: `whe_c${i}`, orgId, url: `https://hooks.slack.com/services/T/B/SECRETCURSOR${i}`, events: "[\"*\"]", secretEnc: "x", description: `Hook ${i}` });
      await ctx.db.insert(webhookDeliveries).values({ id: `whd_c${i}`, orgId, endpointId: `whe_c${i}`, eventType: "message.received", payload: "{\"data\":{}}", status: "failed", attempts: 6, createdAt: new Date(now - i * 1000) });
      await ctx.db.insert(deliveries).values({ id: `dlv_c${i}`, orgId, direction: "outbound", fromAddress: "a@cus.example", toAddress: `hidden${i}@else.example`, subject: "Hi", status: "bounced", provider: "test", createdAt: new Date(now - i * 1000) });
      await ctx.db.insert(suppressions).values({ id: `sup_c${i}`, orgId, address: `gone${i}@else.example`, reason: "hard_bounce" });
    }
    await ctx.db.update(organizations).set({ stripeCustomerId: "cus_cursor_1", subscriptionStatus: "active" }).where(eq(organizations.id, orgId));
  }, 120_000);

  it("a cursor of the wrong type is 400 bad_cursor on every list, never 500", async () => {
    const paths = listPaths(orgId);
    expect(paths.length).toBeGreaterThanOrEqual(20);
    const failures: string[] = [];
    for (const p of paths) {
      const base = await owner.get(p);
      if (base.status !== 200 || !("nextCursor" in (base.body ?? {}))) continue;
      for (const cur of WRONG) {
        const r = await owner.get(`${p}${p.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cur)}`);
        if (r.status !== 400 || r.body?.error?.code !== "bad_cursor") failures.push(`${p} ${Buffer.from(cur, "base64").toString()} -> ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it("on five lists in particular each wrong type is exactly 400 bad_cursor", async () => {
    for (const p of ["/api/console/users", "/api/console/workspaces", "/api/console/audit", "/api/console/jobs", "/api/console/developer/webhooks", "/api/console/mail/deliveries", "/api/console/moderation/reports"]) {
      for (const cur of WRONG) {
        const r = await owner.get(`${p}?cursor=${encodeURIComponent(cur)}`);
        expect(r.status, `${p} ${cur}`).toBe(400);
        expect(r.body.error.code).toBe("bad_cursor");
      }
    }
  }, 120_000);

  it("a number or date cursor on a text sort is 400 bad_cursor", async () => {
    for (const p of ["/api/console/users?sort=email:asc", "/api/console/workspaces?sort=name:asc", "/api/console/developer/api-keys?sort=name:asc",
      "/api/console/mail/suppressions?sort=address:asc", "/api/console/moderation/suspended?sort=name:asc", `/api/console/workspaces/${orgId}/members?sort=email:asc`]) {
      for (const cur of WRONG_FOR_TEXT) {
        const r = await owner.get(`${p}&cursor=${encodeURIComponent(cur)}`);
        expect(r.status, `${p} ${cur}`).toBe(400);
        expect(r.body.error.code).toBe("bad_cursor");
      }
    }
  }, 120_000);

  it("every list's nextCursor carries only values its items show (including the lists that gained ownerEmail)", async () => {
    const checked: string[] = [];
    for (const p of listPaths(orgId)) {
      const r = await owner.get(`${p}${p.includes("?") ? "&" : "?"}limit=1`);
      if (r.status !== 200 || !r.body?.nextCursor) continue;
      if (p === "/api/console/flags") {
        // Flags page by position in a fixed list: the cursor is the last shown flag's key and a constant 0.
        const cur = JSON.parse(Buffer.from(r.body.nextCursor.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
        expect(cur).toEqual({ v: 0, t: "n", id: r.body.items[r.body.items.length - 1].key });
        checked.push(p);
        continue;
      }
      assertCursorFromItems(r.body);
      expect(Buffer.from(r.body.nextCursor.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()).not.toMatch(/SECRETCURSOR|hash-secret|hidden\d@/);
      checked.push(p);
    }
    for (const p of ["/api/console/developer/api-keys", "/api/console/developer/webhooks", "/api/console/developer/webhook-deliveries", "/api/console/mail/deliveries", "/api/console/mail/suppressions", "/api/console/users", "/api/console/workspaces"]) {
      expect(checked, p).toContain(p);
    }
    // ownerEmail is output only: it is on the items, and searching for it matches nothing on lists that do not search emails.
    const hooks = await owner.get("/api/console/developer/webhooks");
    expect(hooks.body.items[0].ownerEmail).toBe("cus@example.com");
    expect((await owner.get("/api/console/developer/webhooks?q=cus@example.com")).body.items).toEqual([]);
    expect((await owner.get("/api/console/developer/api-keys?q=cus@example.com")).body.items).toEqual([]);
  }, 120_000);

  it("recentOnly lists still page by nextCursor with the strict cursor checks", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(webhookDeliveries).values({ id: `whd_r${i}`, orgId, endpointId: "whe_c0", eventType: "message.received", payload: "{}", status: "delivered", attempts: 1, createdAt: new Date(now - (i + 5) * 1000) });
      await ctx.db.insert(deliveries).values({ id: `dlv_r${i}`, orgId, direction: "outbound", fromAddress: "a@cus.example", toAddress: `r${i}@else.example`, subject: "Hi", status: "delivered", provider: "test", createdAt: new Date(now - (i + 5) * 1000) });
    }
    for (const [p, want] of [["/api/console/developer/webhook-deliveries?status=delivered", ["whd_r0", "whd_r1", "whd_r2"]], ["/api/console/mail/deliveries?status=delivered", ["dlv_r0", "dlv_r1", "dlv_r2"]]] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 10; n++) {
        const r = await owner.get(`${p}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
        expect(r.status, p).toBe(200);
        expect(r.body.recentOnly, p).toBe(true);
        assertCursorFromItems(r.body);
        seen.push(...r.body.items.map((i: { id: string }) => i.id));
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      expect(seen, p).toEqual(want);
    }
  }, 120_000);

  it("a nextCursor carries only values the page shows (users and workspaces by each sort)", async () => {
    for (const [p, sorts] of [["/api/console/users", ["createdAt", "email", "name"]], ["/api/console/workspaces", ["createdAt", "name", "plan"]]] as const) {
      for (const s of sorts) {
        for (const dir of ["asc", "desc"]) {
          const r = await owner.get(`${p}?limit=1&sort=${s}:${dir}`);
          expect(r.status).toBe(200);
          assertCursorFromItems(r.body);
        }
      }
    }
  }, 120_000);
});
