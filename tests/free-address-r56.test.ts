import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { organizations, users } from "@/server/db/schema";
import { suggestFreeLocalPart, freeLocalPartProblem } from "@/server/services/free-address";
import { firstNameGuess, nameFromEmail, autoWorkspaceName } from "@/shared/person-name";

const FREE = { FREE_MAIL_DOMAIN: "mail.multies.si", FREE_MAIL_DAILY_SENDS: "3" };
const PLUS = "mymail.builder+qa4s369a28@mail.example.com";

describe("R56 names from a sign in email (MB-241, MB-248)", () => {
  it("takes the first word of the local part, never the plus tag", () => {
    expect(nameFromEmail(PLUS)).toBe("Mymail");
    expect(nameFromEmail("ada_lovelace99@x.com")).toBe("Ada");
    expect(nameFromEmail("12345@x.com")).toBe("");
    expect(firstNameGuess("Ada Lovelace", PLUS)).toBe("Ada");
    expect(firstNameGuess(PLUS, PLUS)).toBe("Mymail");
    expect(firstNameGuess("", "bidur@example.com")).toBe("Bidur");
    expect(autoWorkspaceName(PLUS, PLUS)).toBe("Mymail's workspace");
    expect(autoWorkspaceName("", "1@x.com")).toBe("My's workspace");
  });
  it("suggests a short valid address from the name, not the raw email", () => {
    const s = suggestFreeLocalPart(PLUS, `${PLUS.split("@")[0]}'s workspace`, PLUS);
    expect(s).toBe("mymail");
    expect(s).not.toContain("qa4");
    expect(suggestFreeLocalPart("QA Four", "Mymail's workspace", PLUS)).toBe("qamail");
    expect(suggestFreeLocalPart("Maximiliana Wolfeschlegelstein", "Extraordinarily Long Company Name Pty")).toBe("maximiliana.extraordinarilyl");
    for (const s2 of [s, suggestFreeLocalPart("Ada", "Acme"), suggestFreeLocalPart("", "", PLUS)]) expect(freeLocalPartProblem(s2)).toBeNull();
  });
  it("never suggests a name the check would refuse, even when the name holds a kept word", () => {
    for (const n of ["ProdMultiesQASecondTest", "Multies", "Admin Person", "Support", "Team", "Fintex"]) {
      const s = suggestFreeLocalPart(n, "Acme Multies team");
      expect(freeLocalPartProblem(s), `${n} gave ${s}`).toBeNull();
    }
  });
  it("never looks up the audit metadata with LIKE (D1 refuses patterns over 50 bytes)", () => {
    const src = readFileSync("src/server/services/free-address.ts", "utf8");
    expect(src).not.toMatch(/\blike\(/);
    expect(src).toContain("instr(");
  });
});

describe("R56 free address check and claim (MB-241, Sentry MYMAIL-API-16)", () => {
  it("answers a 40 letter name (the size that made the 500) and refuses an over long one with 422", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    const email = await c.signup(undefined, "Ada Lovelace", "Acme");
    await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
    const long = "qa.mymailbuilderqa4s369a28";
    const ok = await c.get(`/api/free-address/check?localPart=${long}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ available: true, problem: null });
    const forty = "a".repeat(40);
    expect((await c.get(`/api/free-address/check?localPart=${forty}`)).status).toBe(200);
    const tooLong = await c.get(`/api/free-address/check?localPart=${"a".repeat(65)}`);
    expect(tooLong.status).toBe(422);
    expect(JSON.stringify(tooLong.body)).toContain("too long");
    const fortyOne = await c.get(`/api/free-address/check?localPart=${"a".repeat(41)}`);
    expect(fortyOne.status).toBe(200);
    expect(fortyOne.body).toMatchObject({ available: false });
    const bad = await c.post("/api/free-address", { localPart: "no..dots" });
    expect(bad.status).toBe(422);
    const claim = await c.post("/api/free-address", { localPart: long });
    expect(claim.status).toBe(201);
    const again = await c.get(`/api/free-address/check?localPart=${long}`);
    expect(again.body).toMatchObject({ available: false });
  });
  it("the server suggestion for a plus tag email checks clean", async () => {
    const ctx = await makeTestApp(FREE);
    const c = new Client(ctx.app);
    await c.signup(PLUS, PLUS, "");
    const info = await c.get("/api/free-address");
    expect(info.status).toBe(200);
    const suggestion = (info.body as { suggestion: string }).suggestion;
    expect(suggestion).toBe("mymail");
    const chk = await c.get(`/api/free-address/check?localPart=${suggestion}`);
    expect(chk.status).toBe(200);
  });
});

describe("R56 workspace name after Welcome (MB-248)", () => {
  it("a new workspace is named from the name, and Welcome renames it after the name the person gives", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup(PLUS, PLUS, "");
    const me = await c.get("/api/account/me");
    const orgId = (me.body as { organization: { id: string } }).organization.id;
    let org = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    expect(org!.name).toBe("Mymail's workspace");
    const r = await c.post("/api/account/onboarding", { name: "QA Four", timezone: "Australia/Sydney", locale: "en" });
    expect(r.status).toBe(200);
    org = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    expect(org!.name).toBe("QA's workspace");
  });
  it("a typed company wins, and a renamed workspace is never renamed again", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup(undefined, "Ada Lovelace", "Harbour Ops");
    const me = await c.get("/api/account/me");
    const orgId = (me.body as { organization: { id: string } }).organization.id;
    await c.post("/api/account/onboarding", { name: "Ada Lovelace", timezone: "Australia/Sydney", locale: "en" });
    let org = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId)).get();
    expect(org!.name).toBe("Harbour Ops");
    const c2 = new Client(ctx.app);
    await c2.signup(undefined, "Grace Hopper", "");
    const orgId2 = ((await c2.get("/api/account/me")).body as { organization: { id: string } }).organization.id;
    await c2.post("/api/account/onboarding", { name: "Grace Hopper", company: "Navy Labs", timezone: "Australia/Sydney", locale: "en" });
    org = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId2)).get();
    expect(org!.name).toBe("Navy Labs");
  });
});
