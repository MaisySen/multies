import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { accounts, loginThrottle, sessions, twoFactors, users } from "@/server/db/schema";
import {
  CONSOLE_OPERATOR_ROLES, USER_SESSIONS_CAP, USER_SORTS, clearUserLockout, getUserDetail, listUserSessions, listUsers, markEmailVerified,
} from "@/server/services/console/users";
import type { PageCursor, PageRequest } from "@/server/services/console/workspaces";
import { LOCKOUT, lockedUntil, recordFailure } from "@/server/services/lockout";
import { HttpError } from "@/server/lib/errors";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let ada: Client;
let adaId: string;

const page = (field = "createdAt", dir: "asc" | "desc" = "desc", limit = 50, cursor: PageCursor | null = null): PageRequest => ({ limit, cursor, sort: { field, dir } });
const idOf = async (email: string) => (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get())!.id;

beforeEach(async () => {
  ctx = await makeTestApp();
  ada = new Client(ctx.app);
  await ada.signup("ada@acme.io", "Ada Lovelace", "Acme");
  adaId = await idOf("ada@acme.io");
});

describe("listUsers", () => {
  it("searches address, name and id", async () => {
    await new Client(ctx.app).signup("grace@navy.mil", "Grace Hopper", "Navy");
    const emails = async (q: string) => (await listUsers(ctx.deps, { q, page: page() })).items.map((u) => u.email).sort();
    expect(await emails("NAVY.mil")).toEqual(["grace@navy.mil"]);
    expect(await emails("lovelace")).toEqual(["ada@acme.io"]);
    expect(await emails(adaId)).toEqual(["ada@acme.io"]);
    expect(await emails("%")).toEqual([]);
    expect(await emails("")).toEqual(["ada@acme.io", "grace@navy.mil"]);
    const ada1 = (await listUsers(ctx.deps, { q: "ada@", page: page() })).items[0]!;
    expect(ada1).toMatchObject({ id: adaId, name: "Ada Lovelace", workspaces: 1, kind: "person", operator: false, banned: false });
  });

  it("filters by banned, unverified, operator and two factor", async () => {
    // Inserted directly: the sign up rate limit allows only a few sign ups per test.
    for (const e of ["ban@x.io", "ver@x.io", "op@x.io", "sup@x.io", "tf@x.io"]) await ctx.db.insert(users).values({ id: `usr_${e.split("@")[0]}`, email: e, name: "Person" });
    await ctx.db.update(users).set({ banned: true, banReason: "spam" }).where(eq(users.email, "ban@x.io"));
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, "ver@x.io"));
    await ctx.db.update(users).set({ role: "admin" }).where(eq(users.email, "op@x.io"));
    await ctx.db.update(users).set({ role: "ops_support" }).where(eq(users.email, "sup@x.io"));
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.email, "tf@x.io"));
    const emails = async (filters: Parameters<typeof listUsers>[1]["filters"]) =>
      (await listUsers(ctx.deps, { filters, page: page("email", "asc") })).items.map((u) => u.email);
    const everyone = ["ada@acme.io", "ban@x.io", "op@x.io", "sup@x.io", "tf@x.io", "ver@x.io"];
    expect(await emails({ banned: true })).toEqual(["ban@x.io"]);
    expect(await emails({ banned: false })).toEqual(everyone.filter((e) => e !== "ban@x.io"));
    expect(await emails({ unverified: false })).toEqual(["ver@x.io"]);
    expect(await emails({ unverified: true })).toEqual(everyone.filter((e) => e !== "ver@x.io"));
    expect(await emails({ operator: true })).toEqual(["op@x.io", "sup@x.io"]);
    expect(await emails({ operator: false })).toEqual(everyone.filter((e) => e !== "op@x.io" && e !== "sup@x.io"));
    expect(await emails({ twoFactor: true })).toEqual(["tf@x.io"]);
    expect(await emails({ twoFactor: false, banned: false, operator: false, unverified: true })).toEqual(["ada@acme.io"]);
    const sup = (await listUsers(ctx.deps, { q: "sup@", page: page() })).items[0]!;
    expect(sup).toMatchObject({ role: "ops_support", operator: true });
    expect(CONSOLE_OPERATOR_ROLES).toContain("ops_readonly");
  });

  it("rejects a sort field outside the whitelist", async () => {
    expect(USER_SORTS).toEqual(["createdAt", "email", "name"]);
    for (const field of ["password", "role", "constructor", ""]) {
      const err = await listUsers(ctx.deps, { page: page(field) }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe("bad_sort");
    }
  });

  it("pages by keyset on every sort with no duplicates or gaps", async () => {
    const at = new Date("2026-02-02T00:00:00Z");
    const made: string[] = [];
    for (let i = 0; i < 31; i++) {
      const id = `usr_p${String(i).padStart(2, "0")}`;
      made.push(id);
      await ctx.db.insert(users).values({ id, email: `p${String(i).padStart(2, "0")}@page.io`, name: i % 4 ? `Name ${i}` : "Same Name", createdAt: i < 12 ? at : new Date(at.getTime() + i) });
    }
    const expected = [...made, adaId].sort();
    for (const field of USER_SORTS) {
      for (const dir of ["asc", "desc"] as const) {
        const seen: string[] = [];
        let cursor: PageCursor | null = null;
        let pages = 0;
        do {
          const r = await listUsers(ctx.deps, { page: page(field, dir, 6, cursor) });
          expect(r.items.length).toBeLessThanOrEqual(6);
          seen.push(...r.items.map((u) => u.id));
          cursor = r.next;
          pages++;
        } while (cursor && pages < 50);
        expect(new Set(seen).size).toBe(seen.length);
        expect([...seen].sort()).toEqual(expected);
        expect(pages).toBe(Math.ceil(expected.length / 6));
      }
    }
  });
});

describe("user detail", () => {
  it("profile, memberships with workspace names, linked accounts and 2FA without secrets", async () => {
    await ctx.db.insert(accounts).values({ id: "acc_g", accountId: "google-sub-1", providerId: "google", userId: adaId, accessToken: "ACCESS-TOKEN-x", refreshToken: "REFRESH-TOKEN-x", idToken: "ID-TOKEN-x" });
    await ctx.db.insert(twoFactors).values({ id: "tf_1", userId: adaId, secret: "TOTP-SECRET-x", backupCodes: "BACKUP-CODES-x" });
    await ctx.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, adaId));
    const pwd = (await ctx.db.select().from(accounts).where(eq(accounts.providerId, "credential")).get())!.password!;
    const d = await getUserDetail(ctx.deps, adaId);
    expect(d.profile).toMatchObject({ id: adaId, email: "ada@acme.io", name: "Ada Lovelace", emailVerified: false, operator: false });
    expect(d.memberships).toEqual([expect.objectContaining({ orgName: "Acme", role: "owner", kind: "human", plan: "starter" })]);
    expect(d.accounts.map((a) => [a.providerId, a.hasPassword]).sort()).toEqual([["credential", true], ["google", false]]);
    expect(d.twoFactor).toMatchObject({ enabled: true, configured: true, failedAttempts: 0, lockedUntil: null });
    expect(d.lockout).toEqual({ locked: false, lockedUntil: null, failures: 0, windowStart: null });
    expect(d.activeSessions).toBe(1);
    const text = JSON.stringify(d);
    for (const s of [pwd, "ACCESS-TOKEN-x", "REFRESH-TOKEN-x", "ID-TOKEN-x", "TOTP-SECRET-x", "BACKUP-CODES-x"]) expect(text).not.toContain(s);
    await expect(getUserDetail(ctx.deps, "usr_missing")).rejects.toMatchObject({ status: 404 });
  });

  it("sessions without tokens", async () => {
    await ada.login("ada@acme.io");
    const tokens = (await ctx.db.select({ token: sessions.token }).from(sessions).where(eq(sessions.userId, adaId))).map((s) => s.token);
    expect(tokens.length).toBe(2);
    await ctx.db.insert(sessions).values({ id: "ses_old", token: "OLD-TOKEN-x", userId: adaId, expiresAt: new Date(Date.now() - 1000) });
    const list = await listUserSessions(ctx.deps, adaId);
    expect(list).toHaveLength(3);
    expect(list.find((s) => s.id === "ses_old")!.active).toBe(false);
    expect(list.filter((s) => s.active)).toHaveLength(2);
    const text = JSON.stringify(list);
    for (const t of [...tokens, "OLD-TOKEN-x"]) expect(text).not.toContain(t);
    expect(text).not.toMatch(/"token"/);
    expect(USER_SESSIONS_CAP).toBe(100);
    await expect(listUserSessions(ctx.deps, "usr_missing")).rejects.toMatchObject({ status: 404 });
  });

  it("clears a lockout", async () => {
    const now = new Date();
    for (let i = 0; i < LOCKOUT.MAX_FAILURES; i++) await recordFailure(ctx.db, "ada@acme.io", now);
    expect(await lockedUntil(ctx.db, "ada@acme.io", now)).not.toBeNull();
    expect((await ada.login("ada@acme.io")).status).not.toBe(200);
    const before = await getUserDetail(ctx.deps, adaId);
    expect(before.lockout).toMatchObject({ locked: true, failures: LOCKOUT.MAX_FAILURES });
    expect(await clearUserLockout(ctx.deps, adaId)).toEqual({ userId: adaId, email: "ada@acme.io", wasLocked: true, failures: LOCKOUT.MAX_FAILURES });
    expect(await ctx.db.select().from(loginThrottle).where(eq(loginThrottle.email, "ada@acme.io")).get()).toBeUndefined();
    expect((await getUserDetail(ctx.deps, adaId)).lockout.locked).toBe(false);
    expect((await ada.login("ada@acme.io")).status).toBe(200);
    expect(await clearUserLockout(ctx.deps, adaId)).toMatchObject({ wasLocked: false, failures: 0 });
    await expect(clearUserLockout(ctx.deps, "usr_missing")).rejects.toMatchObject({ status: 404 });
  });

  it("marks an address verified, idempotently", async () => {
    expect(await markEmailVerified(ctx.deps, adaId)).toEqual({ userId: adaId, email: "ada@acme.io", alreadyVerified: false });
    expect((await ctx.db.select({ v: users.emailVerified }).from(users).where(eq(users.id, adaId)).get())!.v).toBe(true);
    expect((await markEmailVerified(ctx.deps, adaId)).alreadyVerified).toBe(true);
    expect((await listUsers(ctx.deps, { filters: { unverified: false }, page: page() })).items.map((u) => u.id)).toEqual([adaId]);
    await expect(markEmailVerified(ctx.deps, "usr_missing")).rejects.toMatchObject({ status: 404 });
  });
});
