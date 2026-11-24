/**
 * PRIV1b P37 (round 2, owner decision): a mailbox at a human member's sign in address receives that person's account
 * mail (password resets, sign in links), so it is that person's personal mailbox: only they open it, whoever created it.
 * Migration 0174 does the same for existing team mailboxes, leaving out the mailboxes the platform relies on.
 */
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { authEmailHooks, domains, mailboxes } from "@/server/db/schema";
import { MIGRATIONS } from "@/server/db/migrations.generated";

type W = Awaited<ReturnType<typeof privacyWorld>>;
const box = async (w: W, id: string) => (await w.ctx.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!;

describe("PRIV1b P37: a mailbox at a member's sign in address is theirs", () => {
  it("made by an admin (app or API) or by the person, it is the person's personal mailbox; team addresses stay team", async () => {
    const w = await privacyWorld();
    const pat = await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `pat${w.n}`, displayName: "Pat" });
    expect(pat.status).toBe(201);
    expect(await box(w, pat.body.mailbox.id)).toMatchObject({ personal: true, ownerUserId: w.pat.id });
    // The admin who made it can't open it; Pat can.
    const adminList = (await w.admin.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable?: boolean }[];
    expect(adminList.find((m) => m.id === pat.body.mailbox.id)?.openable).toBe(false);
    const patList = (await w.pat.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable?: boolean }[];
    expect(patList.find((m) => m.id === pat.body.mailbox.id)?.openable).toBe(true);
    // Her own, made by herself (the owner).
    const olive = await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: `olive${w.n}`, displayName: "Olive" });
    const oliveId = (await w.owner.get("/api/account/me")).body.user.id as string;
    expect(await box(w, olive.body.mailbox.id)).toMatchObject({ personal: true, ownerUserId: oliveId });
    // Through the API with a key.
    const key = (await w.admin.c.post("/api/developer/keys", { name: "k" })).body.secret as string;
    const viaKey = await w.ctx.app.request("/api/v1/mailboxes", { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ domainId: w.domainId, localPart: `max${w.n}`, displayName: "Max" }) });
    expect(viaKey.status).toBe(201);
    const maxId = ((await viaKey.json()) as { id: string }).id;
    expect(await box(w, maxId)).toMatchObject({ personal: true, ownerUserId: w.member.id });
    // A team address is a team mailbox.
    const ops = await w.admin.c.post("/api/mailboxes", { domainId: w.domainId, localPart: `ops${w.n}`, displayName: "Ops" });
    expect(await box(w, ops.body.mailbox.id)).toMatchObject({ personal: false, ownerUserId: null });
  }, 120_000);

  it("migration 0174 converts existing team mailboxes at a member's address, except the ones the platform relies on", async () => {
    const w = await privacyWorld();
    const mk = async (local: string, extra: Partial<typeof mailboxes.$inferInsert> = {}) => {
      const id = `mbx_p37${local.replace(/[^a-z0-9]/g, "")}`;
      await w.ctx.db.insert(mailboxes).values({ id, orgId: w.orgId, domainId: w.domainId, localPart: local, address: `${local}@acme.io`, displayName: local, quotaMb: 100, ...extra });
      return id;
    };
    const pat = await mk(`pat${w.n}`); // an admin made it before the rule
    const ada = await mk(`ada${w.n}`); // sends sign-up emails: stays a team mailbox
    await w.ctx.db.insert(authEmailHooks).values({ id: "ahk_p37", orgId: w.orgId, mailboxId: ada, kind: "supabase", secretEnc: "x", supabaseUrl: "https://abcd1234.supabase.co", appName: "Acme" });
    const max = await mk(`max${w.n}`); // a catch-all: stays
    await w.ctx.db.update(domains).set({ catchAllMailboxId: max }).where(eq(domains.id, w.domainId));
    const ops = await mk(`ops${w.n}`); // nobody signs in with it
    // Rae signs in with an address that is an agent's inbox here, and Rex with support@: both stay.
    await w.ctx.db.run(sql`update users set email = ${`bot${w.n}@acme.io`} where id = ${w.dRead.id}`);
    await w.ctx.db.run(sql`update users set email = 'support@acme.io' where id = ${w.dReply.id}`);
    const support = await mk("support");

    const m = MIGRATIONS.find((x) => x.name.startsWith("0174_"))!;
    expect(m).toBeTruthy();
    for (const st of m.statements) await w.ctx.db.run(sql.raw(st));

    expect(await box(w, pat)).toMatchObject({ personal: true, ownerUserId: w.pat.id });
    for (const id of [ada, max, ops, support, w.boxes.agent, w.boxes.team]) expect(await box(w, id), id).toMatchObject({ personal: false });
    // Already personal mailboxes keep their owner.
    expect(await box(w, w.boxes.personal)).toMatchObject({ personal: true, ownerUserId: w.pat.id });
  }, 120_000);
});
