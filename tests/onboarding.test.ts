import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations, users } from "@/server/db/schema";
import { COUNTRIES, cleanLocale, countryFromLocale, guessCountry, isCountry, isTimeZone, COUNTRY_CURRENCY } from "@/shared/locale";
import { invoiceChase } from "@/server/services/ai";

describe("locale helpers", () => {
  it("knows every ISO country, zone and language tag", () => {
    expect(COUNTRIES.length).toBe(249);
    for (const c of ["BR", "NP", "FR", "AU", "US", "IN", "JP", "ZA"]) expect(isCountry(c)).toBe(true);
    expect(isCountry("XX")).toBe(false);
    expect(isTimeZone("America/Sao_Paulo")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(cleanLocale("pt-br")).toBe("pt-BR");
    expect(cleanLocale("not a tag!")).toBeNull();
    expect(countryFromLocale("pt-BR")).toBe("BR");
    expect(countryFromLocale("ne")).toBeNull();
    expect(guessCountry("ne", "Asia/Kathmandu")).toBe("NP");
    expect(guessCountry("fr-FR", "Europe/Paris")).toBe("FR");
    expect(COUNTRY_CURRENCY.BR).toBe("BRL");
  });

  it("an invoice due date is shown as that date anywhere", () => {
    const out = invoiceChase({ customerName: "Ana Souza", amount: 100, dueDate: "2026-10-01", invoiceNumber: "7", businessName: "Souza Design" }, new Date("2026-10-02T12:00:00Z"));
    expect(out.text).toContain("1 October 2026");
  });
});

describe("onboarding", () => {
  it("a new workspace takes the country from the edge and no fixed zone; onboarding is asked once", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    const up = await c.call("POST", "/api/auth/sign-up/email", { name: "Ana Souza", email: "ana@example.com", password: "a-strong-password" }, { "cf-ipcountry": "BR" });
    expect(up.status).toBe(200);
    const me = (await c.call("GET", "/api/account/me", undefined, { "cf-ipcountry": "BR" })).body;
    expect(me.organization).toMatchObject({ timezone: "UTC", country: "BR", onboarded: false });
    expect(me.user).toMatchObject({ timezone: null, locale: null });
    expect(me.onboarding).toEqual({ needed: true, workspace: true });

    const bad = await c.post("/api/account/onboarding", { name: "Ana", timezone: "Mars/Olympus", locale: "pt-BR" });
    expect(bad.status).toBe(422);
    expect((await c.post("/api/account/onboarding", { name: "", timezone: "America/Sao_Paulo", locale: "pt-BR" })).status).toBe(422);
    expect((await c.post("/api/account/onboarding", { name: "Ana", timezone: "America/Sao_Paulo", locale: "pt-BR", country: "XX" })).status).toBe(422);

    const ok = await c.post("/api/account/onboarding", { name: "Ana Souza", timezone: "America/Sao_Paulo", locale: "pt-br", company: "Souza Design", country: "BR", workspaceTimezone: "America/Sao_Paulo" });
    expect(ok.status).toBe(200);
    const after = (await c.get("/api/account/me")).body;
    expect(after.user).toMatchObject({ name: "Ana Souza", timezone: "America/Sao_Paulo", locale: "pt-BR" });
    expect(after.organization).toMatchObject({ name: "Souza Design", country: "BR", timezone: "America/Sao_Paulo", onboarded: true });
    expect(after.onboarding).toEqual({ needed: false, workspace: false });

    // Changing the person's own zone later leaves the workspace's alone.
    expect((await c.patch("/api/account/preferences", { timezone: "Europe/Paris", locale: "fr-FR" })).status).toBe(200);
    expect((await c.patch("/api/account/preferences", { timezone: "Nowhere/Land" })).status).toBe(422);
    const later = (await c.get("/api/account/me")).body;
    expect(later.user).toMatchObject({ timezone: "Europe/Paris", locale: "fr-FR" });
    expect(later.organization.timezone).toBe("America/Sao_Paulo");
  });

  it("a member saves only their own zone and language, never the workspace's", async () => {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("owner@example.com", "Owner One");
    const orgId = (await owner.get("/api/account/me")).body.organization.id;
    const member = new Client(ctx.app);
    await member.signup("kiran@example.com", "Kiran");
    const kiran = (await ctx.db.select().from(users).where(eq(users.email, "kiran@example.com")).get())!;
    const { members, sessions } = await import("@/server/db/schema");
    await ctx.db.insert(members).values({ id: "mem_k", organizationId: orgId, userId: kiran.id, role: "member" });
    await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, kiran.id));
    const me = (await member.get("/api/account/me")).body;
    expect(me.organization.id).toBe(orgId);
    expect(me.onboarding).toEqual({ needed: true, workspace: false });
    expect((await member.post("/api/account/onboarding", { name: "Kiran", timezone: "Asia/Kathmandu", locale: "ne", company: "Taken over", country: "NP" })).status).toBe(200);
    const org = (await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get())!;
    expect(org.name).not.toBe("Taken over");
    expect(org.country).not.toBe("NP");
    expect((await member.get("/api/account/me")).body.user.timezone).toBe("Asia/Kathmandu");
  });

  it("a workspace made later starts in its creator's zone", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup();
    await c.post("/api/account/onboarding", { name: "Ada", timezone: "Europe/Paris", locale: "fr-FR", country: "FR" });
    const made = await c.post("/api/account/workspaces", { name: "Side project" });
    expect(made.status).toBeLessThan(300);
    const me = (await c.get("/api/account/me")).body;
    expect(me.organization.name).toBe("Side project");
    expect(me.organization).toMatchObject({ timezone: "Europe/Paris", country: "FR" });
  });
});

describe("DF-21: onboarding is not asked again of an established person", () => {
  it("an owner of an onboarded workspace whose zone is missing is not asked again and uses the workspace zone", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("founder@example.com", "Founder");
    await c.post("/api/account/onboarding", { name: "Founder", timezone: "Australia/Sydney", locale: "en-AU", company: "Haajir HQ", country: "AU", workspaceTimezone: "Australia/Sydney" });
    // A sign in move gives the person a fresh identity; their own zone is gone, the workspace's is not.
    await ctx.db.update(users).set({ timezone: null, locale: null }).where(eq(users.email, "founder@example.com"));
    const me = (await c.get("/api/account/me")).body;
    expect(me.organization.onboarded).toBe(true);
    expect(me.onboarding).toEqual({ needed: false, workspace: false });
    expect(me.user.timezone).toBe("Australia/Sydney");
  });

  it("a member who joins after onboarding is still asked once; one who was there before is not", async () => {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("owner2@example.com", "Owner Two");
    const orgId = (await owner.get("/api/account/me")).body.organization.id;
    const early = new Client(ctx.app);
    await early.signup("early@example.com", "Early");
    await ctx.db.update(users).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(users.email, "early@example.com"));
    await owner.post("/api/account/onboarding", { name: "Owner Two", timezone: "Europe/Paris", locale: "fr-FR", company: "Acme", country: "FR", workspaceTimezone: "Europe/Paris" });
    const late = new Client(ctx.app);
    await late.signup("late@example.com", "Late");
    const { members, sessions } = await import("@/server/db/schema");
    for (const email of ["early@example.com", "late@example.com"]) {
      const u = (await ctx.db.select().from(users).where(eq(users.email, email)).get())!;
      await ctx.db.insert(members).values({ id: `mem_${u.id}`, organizationId: orgId, userId: u.id, role: "member" });
      await ctx.db.update(sessions).set({ activeOrganizationId: orgId }).where(eq(sessions.userId, u.id));
    }
    expect((await early.get("/api/account/me")).body.onboarding).toEqual({ needed: false, workspace: false });
    expect((await late.get("/api/account/me")).body.onboarding).toEqual({ needed: true, workspace: false });
  });

  it("personPredates reads the stored onboarding time", async () => {
    const { personPredates } = await import("@/server/routes/account");
    expect(personPredates(new Date("2026-10-01T00:00:00Z"), "2026-10-02T00:00:00.000Z")).toBe(true);
    expect(personPredates(new Date("2026-10-03T00:00:00Z"), "2026-10-02T00:00:00.000Z")).toBe(false);
    expect(personPredates(null, "2026-10-02T00:00:00.000Z")).toBe(false);
    expect(personPredates(new Date(), undefined)).toBe(false);
    expect(personPredates(new Date(), "not a date")).toBe(false);
  });
});
